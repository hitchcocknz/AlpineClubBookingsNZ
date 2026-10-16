/**
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): BANK-TRANSFER
 * REFUNDS WHOSE XERO CREDIT NOTE WAS VOIDED.
 *
 * On a bank transfer Xero is the payment rail (`INV-ADDPAY-021`), so a voided
 * refund note undoes the refund (`INV-ADDPAY-041`): the inbound sync recounts
 * the payment's refunded total from the live notes and nothing re-raises the
 * note. Before this list such a refund showed nowhere. It is built from the
 * voided note itself, one item per note, never from a refunded-total gap: on a
 * bank transfer that total also counts modification and account-credit notes,
 * which the refund-note coverage does not, so a gap would raise false alarms.
 * The card report (`getRefundsMissingXeroCreditNotes`) stays card-only, because
 * the nightly self-heal raises notes from it automatically, and a void is never
 * re-raised automatically (owner, 15 Oct 2026 on #4091).
 *
 * AN ITEM is a voided note V where:
 * - V's payment is `INTERNET_BANKING`;
 * - V is a `REFUND_CREDIT_NOTE` link (an edit's, an account-credit or a refund
 *   request's note has another role, and is out of scope: #4195);
 * - its link records VOIDED or DELETED and is inactive (an ACTIVE voided mirror
 *   is the reconciliation report's drift until #4161's heal turns it off, so
 *   nothing is listed twice);
 * - the void is more than `REFUND_CREDIT_NOTE_GRACE_HOURS` old (the link's
 *   last write, which is the void);
 * - V has no `BankRefundVoidResolution` - except a record-again whose own note
 *   did not land, which comes back flagged (`note-failed`). A record-again
 *   whose own note was voided in its turn comes back as THAT note's own item,
 *   flagged `voided-again` and naming V.
 *
 * Each item carries what the treasurer needs to answer it: V's recorded amount
 * (null when it cannot be read, which refuses both answers), the payment's
 * live refund notes (a note replaced by hand in Xero shows there, Q4), and why
 * a record-again would be refused now. The writers re-read the same facts under
 * their locks (`readBankRefundVoidUnderLock`), so the list is advice.
 */
import type { Prisma } from "@prisma/client";

import { reRecordNoteRowsWhere } from "@/lib/bank-refund-re-record-note";
import type { ReRecordRefusal } from "@/lib/bank-refund-void-copy";
import { formatBookingReference } from "@/lib/booking-reference";
import { prisma } from "@/lib/prisma";
import { REFUND_CREDIT_NOTE_GRACE_HOURS } from "@/lib/xero-refund-note-grace";
import { asRecord, readString } from "@/lib/xero-json";
import { findBlockingRefundCreditNoteOperationId } from "@/lib/xero-refund-note-link-repair";
import {
  isRefundCreditNoteLinkCancelledInXero,
  recordedRefundNoteAmountCents,
} from "@/lib/xero-refund-note-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

type Reader = Prisma.TransactionClient;

/** The statuses Xero's two cancelled states are recorded under on a link. */
const CANCELLED_STATUSES = ["VOIDED", "DELETED"] as const;

/** The refund-note links this list is made of, before the payment's source is known. */
function voidedRefundNoteLinkWhere(voidedBefore: Date) {
  return {
    localModel: "Payment",
    xeroObjectType: "CREDIT_NOTE",
    role: "REFUND_CREDIT_NOTE",
    active: false,
    updatedAt: { lt: voidedBefore },
    OR: CANCELLED_STATUSES.map((status) => ({ metadata: { path: ["status"], equals: status } })),
  } satisfies Prisma.XeroObjectLinkWhereInput;
}

/** When a void counts as settled: the link's last write is older than the grace window. */
export function bankRefundVoidGraceThreshold(now: Date): Date {
  return new Date(now.getTime() - REFUND_CREDIT_NOTE_GRACE_HOURS * 60 * 60 * 1000);
}


/** Why an item is back after a record-again; null for an unanswered note. */
export type BankRefundVoidFlag = "note-failed" | "voided-again";

export interface BankRefundVoidLiveNote {
  creditNoteId: string;
  creditNoteNumber: string | null;
  amountCents: number | null;
}

export interface BankRefundVoidItem {
  /** The voided note's link: the id the two actions take. */
  linkId: string;
  paymentId: string;
  bookingId: string;
  bookingReference: string;
  voidedCreditNoteId: string;
  voidedCreditNoteNumber: string | null;
  /** The voided note's recorded amount, or null when it cannot be read. */
  amountCents: number | null;
  /** When the void was recorded (the link's last write, ISO instant). */
  voidedAt: string;
  /** The payment's live refund notes, so a note already replaced by hand in Xero shows (Q4). */
  liveNotes: BankRefundVoidLiveNote[];
  flag: BankRefundVoidFlag | null;
  /** `voided-again`: the earlier voided note this one re-recorded. */
  reRecordOf: string | null;
  /** Null when record-again is allowed. A flagged item takes no action here. */
  reRecordRefusal: ReRecordRefusal | null;
  /** Whether either answer can be given here: false for a flagged `note-failed` item, already answered. */
  answerable: boolean;
}

/** The voided note link's fields every reader here needs. */
const LINK_SELECT = {
  id: true,
  localId: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  metadata: true,
  active: true,
  role: true,
  localModel: true,
  xeroObjectType: true,
  updatedAt: true,
} as const satisfies Prisma.XeroObjectLinkSelect;

type VoidedLink = Prisma.XeroObjectLinkGetPayload<{ select: typeof LINK_SELECT }>;

/** The voided note's own create row, oldest first: the row that raised it (`recordedRefundNoteAmountCents`'s rule). */
export async function readVoidedNoteCreateRow(db: Reader, paymentId: string, creditNoteId: string) {
  return db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId: creditNoteId,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, requestPayload: true, manuallyResolvedAt: true },
  });
}

/** `INV-INT-025`: a create row for V an officer marked resolved in Xero by hand - its amount may count as coverage still. */
async function voidedNoteResolvedInXero(db: Reader, paymentId: string, creditNoteId: string): Promise<boolean> {
  const resolved = await db.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId: creditNoteId,
      manuallyResolvedAt: { not: null },
    },
    select: { id: true },
  });
  return resolved !== null;
}

/** The record-again a note's create row answers, if it was one (`reRecordId` on its payload). */
async function reRecordOfNote(db: Reader, paymentId: string, creditNoteId: string): Promise<string | null> {
  const create = await readVoidedNoteCreateRow(db, paymentId, creditNoteId);
  if (!create) return null;
  // By the id its payload carries, or by the row the record-again queued
  // (a draining older worker rewrites the payload without the id).
  const reRecordId = readString(asRecord(create.requestPayload)?.reRecordId);
  const resolution = await db.bankRefundVoidResolution.findFirst({
    where: {
      paymentId,
      outcome: "RE_RECORDED",
      OR: [...(reRecordId ? [{ id: reRecordId }] : []), { noteOperationId: create.id }],
    },
    select: { voidedCreditNoteId: true },
  });
  return resolution?.voidedCreditNoteId ?? null;
}

/** The statuses in which a record-again's own note row may still raise its note. */
const IN_PROGRESS_STATUSES = ["PENDING", "RUNNING", "WAITING_PAYMENT"];

/**
 * Whether a record-again's own note landed: its own notes cover its amount,
 * or a row is still on its way (not yet a failure). A note of its own Xero
 * voided in turn is that note's own item, never this one's.
 */
async function reRecordNoteState(
  db: Reader,
  paymentId: string,
  resolution: { id: string; amountCents: number; noteOperationId: string | null },
): Promise<"landed" | "on-its-way" | "voided-again" | "failed"> {
  const rowsWhere = reRecordNoteRowsWhere(paymentId, resolution.id, resolution.noteOperationId);
  const coveredCents = await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  if (coveredCents >= resolution.amountCents) return "landed";
  const rows =
    (await db.xeroSyncOperation.findMany({ where: rowsWhere, select: { status: true, xeroObjectId: true } })) ?? [];
  if (rows.some((row) => IN_PROGRESS_STATUSES.includes(row.status))) return "on-its-way";
  const ownNoteIds = rows.flatMap((row) => (row.xeroObjectId ? [row.xeroObjectId] : []));
  if (ownNoteIds.length > 0) {
    const voided = await db.xeroObjectLink.findFirst({
      where: {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        xeroObjectId: { in: ownNoteIds },
        OR: CANCELLED_STATUSES.map((status) => ({ metadata: { path: ["status"], equals: status } })),
      },
      select: { id: true },
    });
    if (voided) return "voided-again";
  }
  return "failed";
}

/** The payment's live refund notes, with their recorded amounts. */
async function liveRefundNotes(db: Reader, paymentId: string): Promise<BankRefundVoidLiveNote[]> {
  const links =
    (await db.xeroObjectLink.findMany({
      where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE", active: true },
      orderBy: { createdAt: "asc" },
      select: { xeroObjectId: true, xeroObjectNumber: true, metadata: true },
    })) ?? [];
  return Promise.all(
    links.map(async (link) => ({
      creditNoteId: link.xeroObjectId,
      creditNoteNumber: link.xeroObjectNumber ?? null,
      amountCents: await recordedRefundNoteAmountCents(paymentId, link, db),
    })),
  );
}

/** The voided note's recorded amount in cents, or null when unreadable or not positive. */
async function voidedAmountCents(db: Reader, paymentId: string, link: VoidedLink): Promise<number | null> {
  const cents = await recordedRefundNoteAmountCents(paymentId, link, db);
  return cents !== null && Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Why a record-again of this note would be refused now, or null. */
async function reRecordRefusalFor(
  db: Reader,
  paymentId: string,
  creditNoteId: string,
  amountCents: number | null,
): Promise<ReRecordRefusal | null> {
  if (amountCents === null) return "amount-unknown";
  if (await voidedNoteResolvedInXero(db, paymentId, creditNoteId)) return "resolved-in-xero";
  // A refund-note create that could still mint on this payment (the #2901
  // repair's rule): its coverage read could take this record-again's raise.
  if (await findBlockingRefundCreditNoteOperationId(paymentId, db)) return "note-in-flight";
  return null;
}

/** Whether a link is one this list is made of, on a payment with the given source, as of `now`. */
function isListableVoidedLink(link: VoidedLink, voidedBefore: Date): boolean {
  return (
    link.localModel === "Payment" &&
    link.xeroObjectType === "CREDIT_NOTE" &&
    link.role === "REFUND_CREDIT_NOTE" &&
    !link.active &&
    isRefundCreditNoteLinkCancelledInXero(link.metadata) &&
    link.updatedAt < voidedBefore
  );
}

/**
 * Every listed item, oldest void first. Reads with `db` (the singleton by
 * default); the writers do not call this - they read one item under their
 * locks.
 */
export async function listBankRefundVoids(options?: { now?: Date; db?: Reader }): Promise<BankRefundVoidItem[]> {
  const db = options?.db ?? (prisma as unknown as Reader);
  const voidedBefore = bankRefundVoidGraceThreshold(options?.now ?? new Date());
  const links =
    (await db.xeroObjectLink.findMany({
      where: voidedRefundNoteLinkWhere(voidedBefore),
      orderBy: { updatedAt: "asc" },
      select: LINK_SELECT,
    })) ?? [];
  const candidates = links.filter((link) => isListableVoidedLink(link, voidedBefore));
  if (candidates.length === 0) return [];
  const paymentIds = [...new Set(candidates.map((link) => link.localId))];
  const payments =
    (await db.payment.findMany({
      where: { id: { in: paymentIds }, source: "INTERNET_BANKING" },
      select: { id: true, bookingId: true },
    })) ?? [];
  const bookingByPayment = new Map(payments.map((payment) => [payment.id, payment.bookingId]));
  const resolutions =
    (await db.bankRefundVoidResolution.findMany({
      where: { paymentId: { in: [...bookingByPayment.keys()] } },
      select: { id: true, paymentId: true, voidedCreditNoteId: true, outcome: true, amountCents: true, noteOperationId: true },
    })) ?? [];
  const resolutionOf = new Map(resolutions.map((row) => [`${row.paymentId}|${row.voidedCreditNoteId}`, row]));

  const items: BankRefundVoidItem[] = [];
  for (const link of candidates) {
    const bookingId = bookingByPayment.get(link.localId);
    if (!bookingId) continue;
    const resolution = resolutionOf.get(`${link.localId}|${link.xeroObjectId}`) ?? null;
    let flag: BankRefundVoidFlag | null = null;
    if (resolution) {
      if (resolution.outcome !== "RE_RECORDED") continue;
      if ((await reRecordNoteState(db, link.localId, resolution)) !== "failed") continue;
      flag = "note-failed";
    }
    const reRecordOf = resolution ? null : await reRecordOfNote(db, link.localId, link.xeroObjectId);
    if (reRecordOf) flag = "voided-again";
    const amountCents = await voidedAmountCents(db, link.localId, link);
    items.push({
      linkId: link.id,
      paymentId: link.localId,
      bookingId,
      bookingReference: formatBookingReference(bookingId),
      voidedCreditNoteId: link.xeroObjectId,
      voidedCreditNoteNumber: link.xeroObjectNumber ?? null,
      amountCents,
      voidedAt: link.updatedAt.toISOString(),
      liveNotes: await liveRefundNotes(db, link.localId),
      flag,
      reRecordOf,
      reRecordRefusal: resolution ? null : await reRecordRefusalFor(db, link.localId, link.xeroObjectId, amountCents),
      answerable: resolution === null,
    });
  }
  return items;
}

/** How many items the list holds: the health snapshot's count. */
export async function countBankRefundVoids(options?: { now?: Date }): Promise<number> {
  return (await listBankRefundVoids(options)).length;
}

/** What a writer reads of one voided note, under its locks. */
export interface BankRefundVoidUnderLock {
  link: VoidedLink;
  paymentId: string;
  amountCents: number | null;
  /** The answer already recorded for this note, if any. */
  resolution: { id: string; outcome: "RE_RECORDED" | "CONFIRMED_CANCELLED" } | null;
  reRecordRefusal: ReRecordRefusal | null;
}

/**
 * One voided note as a writer must see it, read on the writer's transaction
 * after its locks: null when the id names no voided bank-transfer refund note
 * this list would show (missing, still active, not voided, inside the grace
 * window, or not on a bank-transfer payment).
 */
export async function readBankRefundVoidUnderLock(
  db: Reader,
  linkId: string,
  now: Date,
): Promise<BankRefundVoidUnderLock | null> {
  const link = await db.xeroObjectLink.findUnique({ where: { id: linkId }, select: LINK_SELECT });
  if (!link || !isListableVoidedLink(link, bankRefundVoidGraceThreshold(now))) return null;
  const payment = await db.payment.findUnique({ where: { id: link.localId }, select: { source: true } });
  if (payment?.source !== "INTERNET_BANKING") return null;
  const resolution = await db.bankRefundVoidResolution.findUnique({
    where: { paymentId_voidedCreditNoteId: { paymentId: link.localId, voidedCreditNoteId: link.xeroObjectId } },
    select: { id: true, outcome: true },
  });
  const amountCents = await voidedAmountCents(db, link.localId, link);
  return {
    link,
    paymentId: link.localId,
    amountCents,
    resolution,
    reRecordRefusal: await reRecordRefusalFor(db, link.localId, link.xeroObjectId, amountCents),
  };
}

/** The payment id a voided-note link id names, read without a lock (the writer locks the payment by it). */
export async function readBankRefundVoidPaymentId(db: Reader, linkId: string): Promise<string | null> {
  const link = await db.xeroObjectLink.findUnique({ where: { id: linkId }, select: { localModel: true, localId: true } });
  return link?.localModel === "Payment" ? link.localId : null;
}
