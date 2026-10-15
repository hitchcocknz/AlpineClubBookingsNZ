// Which Xero credit-note statuses still count as refund coverage, and how a
// link's recorded status is read. ONE home, by design (#2901 review): every
// refund valuation — the inbound contribution math, the coverage sum behind
// the outbox enqueue/executor and the daily self-heal, canonical link cleanup,
// the drift report, and the operator repair — answers "does this note still
// count?" through these helpers, so no path can treat a VOIDED note as live
// coverage while its siblings do not. A pure leaf: import it from anywhere.
import type { Prisma } from "@prisma/client";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { providerAmountToCents } from "@/lib/money-provider-amount";

/**
 * True when a Xero credit-note status still contributes to refund coverage.
 * Unknown shapes (missing/non-string status) COUNT — outbound-created links
 * carry no status until inbound reconciliation or the operator status
 * recorder merges one, and their notes are live. Only an explicit
 * VOIDED/DELETED is excluded. Note the assumption this bakes in: a
 * non-cancelled recorded status (DRAFT, SUBMITTED, PAID, ...) counts as live
 * coverage. That is safe because the system only ever creates AUTHORISED
 * refund credit notes; a hand-crafted DRAFT note linked as refund coverage
 * would count here before it credits anything in Xero (#2901 stated limit).
 */
export function isIncludedRefundCreditNoteStatus(status: unknown) {
  if (typeof status !== "string") {
    return true;
  }

  const normalized = status.trim().toUpperCase();
  return normalized !== "VOIDED" && normalized !== "DELETED";
}

/** The link's recorded Xero status (uppercased), or null when never recorded. */
export function readRefundCreditNoteLinkStatus(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const status = record ? readString(record.status) : null;
  return status ? status.trim().toUpperCase() : null;
}

/**
 * True when the link's recorded status says the Xero document was cancelled
 * (VOIDED/DELETED). False when no status was ever recorded — callers that
 * need "positively known live" must check `readRefundCreditNoteLinkStatus`
 * for null themselves.
 */
export function isRefundCreditNoteLinkCancelledInXero(metadata: unknown): boolean {
  const status = readRefundCreditNoteLinkStatus(metadata);
  return status !== null && !isIncludedRefundCreditNoteStatus(status);
}

/**
 * #3880: a refund note raised PER REFUND on a non-Stripe payment - a review's
 * bank-transfer hand-back on a cancelled booking, sized as a delta
 * (`createXeroCreditNote` stamps `perDelta` on its link). Like a Stripe delta
 * (#1162) it stays active beside its siblings, so coverage totals all of them,
 * and it is never the payment's ONE canonical note that its single-refund
 * callers (hold expiry, group cancel, a cancellation hand-back) dedupe on.
 */
export function isPerDeltaRefundNoteLink(metadata: unknown): boolean {
  return asRecord(metadata)?.perDelta === true;
}

/**
 * #3880 F1: the evidence for a payment's ONE canonical refund note with every
 * per-refund note left out - the field (`canonicalRefundNoteFromField`), its
 * links, and its create rows, which `createXeroCreditNote` stamps `perDelta` as
 * it stamps the link. The booking-repair pass resolves the field from this, so
 * a per-refund note is neither offered as the field nor read as a conflict.
 */
export function canonicalRefundNoteCandidates<
  L extends { role: string; xeroObjectId: string; metadata: unknown },
  O extends { requestPayload: unknown; xeroObjectId: string | null },
>(fieldNoteId: string | null | undefined, links: L[], operations: O[]) {
  const perDeltaIds = new Set(
    links.filter((link) => link.role === "REFUND_CREDIT_NOTE" && isPerDeltaRefundNoteLink(link.metadata)).map((link) => link.xeroObjectId),
  );
  return {
    fieldObjectId: canonicalRefundNoteFromField(fieldNoteId, perDeltaIds),
    links: links.filter((link) => !perDeltaIds.has(link.xeroObjectId)),
    operations: operations.filter(
      (operation) =>
        asRecord(operation.requestPayload)?.perDelta !== true && !(operation.xeroObjectId && perDeltaIds.has(operation.xeroObjectId)),
    ),
  };
}

/** The refund-note links of one payment (or several), active or not: the one fetch every reader below shares. */
async function readRefundNoteLinks(localId: string | { in: string[] }, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  return (await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" },
    select: { xeroObjectId: true, metadata: true },
  })) ?? [];
}

/**
 * The payment's refund notes, active or not, in one read on the caller's client:
 * its per-refund notes (#3880), and the notes Xero recorded VOIDED/DELETED,
 * which are never re-adopted as its one refund note (`INV-ADDPAY-041`).
 */
export async function refundNoteIdSets(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<{ perDelta: Set<string>; cancelled: Set<string> }> {
  const links = await readRefundNoteLinks(paymentId, db);
  const idsWhere = (keep: (metadata: unknown) => boolean) =>
    new Set(links.filter((link) => keep(link.metadata)).map((link) => link.xeroObjectId));
  return { perDelta: idsWhere(isPerDeltaRefundNoteLink), cancelled: idsWhere(isRefundCreditNoteLinkCancelledInXero) };
}

/** `refundNoteIdSets(...).cancelled` for several payments at once (the booking repair's loader). */
export async function cancelledRefundNoteIds(
  paymentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const links = await readRefundNoteLinks({ in: [...paymentIds] }, db);
  return new Set(links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata)).map((link) => link.xeroObjectId));
}

/** What a refund note's idempotency key is built on: a watermark (v2), an amount (v1), or a close's own rows (v3). */
export type RefundNoteKeyScope =
  | { watermarkCents: number }
  | { amountCents: number }
  | { closeRowsWhere: Prisma.XeroSyncOperationWhereInput };

/**
 * A refund-note link's recorded watermark or amount, or null when neither the
 * link nor its create row records it (`INV-ADDPAY-041` fails closed on null).
 * Inbound, backfilled and pre-#1162 links carry no figures; the create row's
 * payload does (`allocation.amount` in dollars, or the queued figures).
 */
async function recordedRefundNoteFigure(
  paymentId: string,
  link: { xeroObjectId: string; metadata: unknown },
  field: "watermarkCents" | "amountCents",
  db: Pick<Prisma.TransactionClient, "xeroSyncOperation">,
): Promise<number | null> {
  const onLink = readNumber(asRecord(link.metadata)?.[field]);
  if (onLink !== null) return onLink;
  // Oldest first: the row that raised the note. A later row closed as covered
  // by it carries its own enqueue figures, not the note's.
  const create = await db.xeroSyncOperation.findFirst({
    where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: link.xeroObjectId },
    orderBy: { createdAt: "asc" },
    select: { requestPayload: true },
  });
  const payload = asRecord(create?.requestPayload);
  if (field === "watermarkCents") return readNumber(payload?.watermarkCents);
  return readNumber(payload?.refundAmountCents) ?? providerAmountToCents(asRecord(payload?.allocation)?.amount);
}

/**
 * `INV-ADDPAY-041`: the parts a refund note's key gains once the payment has a
 * voided refund note, `after-void:<sorted ids>`, so a reissue never sends a key
 * Xero has answered before. A void moves coverage, so a reissue's base can equal
 * the voided note's own key or a LIVE note's: the suffix names every refund
 * note, live or voided, whose recorded watermark (v2) or amount (v1) equals the
 * key's base - one whose figure cannot be recovered counts as equal (fail
 * closed) - or, once a "Paid another way" close has a voided note, every note
 * its own rows raised (v3). A lost attempt's own note has no link yet, so its
 * retry keeps its key; with no void the key is byte-identical. The one home
 * for the enqueue's correlation key and the executor's Xero key.
 */
export async function refundNoteKeyAfterVoidParts(
  paymentId: string,
  scope: RefundNoteKeyScope,
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<string[]> {
  const links = await readRefundNoteLinks(paymentId, db);
  const voided = links.filter((link) => isRefundCreditNoteLinkCancelledInXero(link.metadata));
  if (voided.length === 0) return [];
  const named: string[] = [];
  if ("closeRowsWhere" in scope) {
    const rows = (await db.xeroSyncOperation.findMany({ where: scope.closeRowsWhere, select: { xeroObjectId: true } })) ?? [];
    const own = new Set(rows.map((row) => row.xeroObjectId));
    if (voided.some((link) => own.has(link.xeroObjectId))) {
      named.push(...links.filter((link) => own.has(link.xeroObjectId)).map((link) => link.xeroObjectId));
    }
  } else {
    const [field, cents] = "watermarkCents" in scope ? (["watermarkCents", scope.watermarkCents] as const) : (["amountCents", scope.amountCents] as const);
    for (const link of links) {
      const recorded = await recordedRefundNoteFigure(paymentId, link, field, db);
      if (recorded === null || recorded === cents) named.push(link.xeroObjectId);
    }
  }
  const ids = [...new Set(named)].sort();
  return ids.length > 0 ? ["after-void", ...ids] : [];
}

/**
 * `INV-ADDPAY-041` defence in depth: throws, before anything is recorded, when
 * Xero answered a refund-note create with a note this payment must not take -
 * one Xero reports or a link records VOIDED/DELETED, or one another create row
 * on this payment already raised. No key reuse can then re-adopt or relabel a
 * note; the row fails with this message for an officer to read.
 */
export async function assertFreshRefundNoteFromCreate(
  paymentId: string,
  operationId: string,
  created: { creditNoteID: string; status?: unknown },
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "xeroSyncOperation">,
): Promise<void> {
  const voidedInXero = typeof created.status === "string" && !isIncludedRefundCreditNoteStatus(created.status);
  if (voidedInXero || (await refundNoteIdSets(paymentId, db)).cancelled.has(created.creditNoteID)) {
    throw new Error(
      `Refusing to record Xero credit note ${created.creditNoteID} for payment ${paymentId}: Xero answered with a VOIDED or DELETED note, which is never re-adopted (INV-ADDPAY-041). Check the note in Xero before retrying.`,
    );
  }
  const other = await db.xeroSyncOperation.findFirst({
    where: { entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId, xeroObjectId: created.creditNoteID, id: { not: operationId } },
    select: { id: true },
  });
  if (other) {
    throw new Error(
      `Refusing to record Xero credit note ${created.creditNoteID} for payment ${paymentId}: operation ${other.id} already raised it, so this create would relabel another refund's note (INV-ADDPAY-041). Check the note in Xero before retrying.`,
    );
  }
}

/** #3880: the payment's per-refund notes, active or not, read on the caller's client. */
export async function perDeltaRefundNoteIds(paymentId: string, db: Prisma.TransactionClient): Promise<Set<string>> {
  return (await refundNoteIdSets(paymentId, db)).perDelta;
}

/**
 * #3880: THE PAYMENT'S ONE CANONICAL REFUND NOTE, as `Payment.xeroRefundCreditNoteId`
 * records it: the field, unless it names a per-refund note, which is never
 * canonical. Every reader of the field that dedupes on it or retires siblings
 * for it asks here, so a field an older writer pointed at a per-refund note
 * cannot hide the cancellation's own note.
 */
export function canonicalRefundNoteFromField(
  fieldNoteId: string | null | undefined,
  perDeltaNoteIds: ReadonlySet<string>,
): string | null {
  return fieldNoteId && !perDeltaNoteIds.has(fieldNoteId) ? fieldNoteId : null;
}

/** The notes that are never the payment's one refund note: per-refund (#3880) and voided (`INV-ADDPAY-041`). */
export async function neverCanonicalRefundNoteIds(paymentId: string, db: Pick<Prisma.TransactionClient, "xeroObjectLink">) {
  const { perDelta, cancelled } = await refundNoteIdSets(paymentId, db);
  return new Set([...perDelta, ...cancelled]);
}

/** #3880: `canonicalRefundNoteFromField`, never a per-refund or (`INV-ADDPAY-041`) voided note, on the caller's client. */
export async function readCanonicalRefundNoteField(
  payment: { id: string; xeroRefundCreditNoteId: string | null } | null | undefined,
  db: Prisma.TransactionClient,
): Promise<string | null> {
  if (!payment?.xeroRefundCreditNoteId) return null;
  return canonicalRefundNoteFromField(payment.xeroRefundCreditNoteId, await neverCanonicalRefundNoteIds(payment.id, db));
}

/**
 * Whether a note may be written into `Payment.xeroRefundCreditNoteId`: never a
 * per-refund one (#3880), and never one Xero voided (`INV-ADDPAY-041`).
 */
export async function mayRecordAsCanonicalRefundNote(
  paymentId: string,
  creditNoteId: string,
  db: Prisma.TransactionClient,
): Promise<boolean> {
  return !(await neverCanonicalRefundNoteIds(paymentId, db)).has(creditNoteId);
}
