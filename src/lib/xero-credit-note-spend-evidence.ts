/**
 * #4220 (lane a): what the app keeps, with a credit note's existing Xero link,
 * of what Xero already sent about that note's spend.
 *
 * The inbound credit-note reconcile holds the whole note (total, remaining
 * credit, allocations, payments). When the note funds a member's credit lot it
 * keeps that reading, in exact cents, under ONE key of the link's metadata, so
 * the repair check and the Xero health summary can ask "did Xero spend this
 * note on something the app has no record of?" later, from the database alone,
 * with no Xero call. It stores the READING, not a verdict: whether the spend is
 * the app's own depends on local links that can land after the reading, so the
 * verdict is derived each time it is asked for (`xero-credit-note-spent-outside-flag.ts`).
 *
 * One key, replaced whole, so a later merge of the link's status snapshot
 * (`xeroCreditNoteSnapshotMetadata`) can never leave old allocations beside a
 * newer total. Nothing here reads or writes Xero or the credit ledger.
 */
import type { Prisma } from "@prisma/client";
import {
  creditNoteMirrorEvidenceFrom,
  type CreditNoteMirrorEvidence,
  type XeroCreditNoteLike,
} from "@/lib/xero-credit-note-outside-spend";
import { NOT_A_CONVERGENCE_ROW } from "@/lib/xero-credit-note-write-down";

/** The `XeroObjectLink.metadata` key holding the reading. */
export const CREDIT_NOTE_SPEND_EVIDENCE_KEY = "spendEvidence";

/** The reading as stored: JSON-safe, exact cents, times as ISO strings. */
export interface StoredCreditNoteSpendEvidence {
  status: string | null;
  totalCents: number | null;
  remainingCents: number | null;
  allocations: Array<{ invoiceId: string; cents: number }>;
  payments: Array<{ paymentId: string; cents: number }>;
  /** Xero's `UpdatedDateUTC` for the reading, or null when Xero sent none. */
  noteUpdatedAt: string | null;
  /** When the app took the reading. */
  observedAt: string;
}

export function storedSpendEvidenceFrom(evidence: CreditNoteMirrorEvidence, observedAt: Date): StoredCreditNoteSpendEvidence {
  return {
    status: evidence.status,
    totalCents: evidence.totalCents,
    remainingCents: evidence.remainingCents,
    allocations: evidence.allocations.map((a) => ({ invoiceId: a.invoiceId, cents: a.cents })),
    payments: evidence.payments.map((p) => ({ paymentId: p.paymentId, cents: p.cents })),
    noteUpdatedAt: evidence.updatedAt?.toISOString() ?? null,
    observedAt: observedAt.toISOString(),
  };
}

const isCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNullableCents = (value: unknown): value is number | null => value === null || isCents(value);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The reading out of a link's metadata, or null for anything that is not
 * exactly the shape written above (absent, hand-edited, from an older build):
 * a reading that cannot be trusted raises no flag.
 */
export type ReadCreditNoteSpendEvidence = Omit<CreditNoteMirrorEvidence, "creditNoteId"> & { observedAt: Date };

export function readStoredSpendEvidence(metadata: unknown): ReadCreditNoteSpendEvidence | null {
  const raw = asRecord(asRecord(metadata)?.[CREDIT_NOTE_SPEND_EVIDENCE_KEY]);
  if (!raw) return null;
  const { status, totalCents, remainingCents, allocations, payments, noteUpdatedAt, observedAt } = raw;
  if (status !== null && typeof status !== "string") return null;
  if (!isNullableCents(totalCents) || !isNullableCents(remainingCents)) return null;
  if (!Array.isArray(allocations) || !Array.isArray(payments)) return null;
  const readAllocations: CreditNoteMirrorEvidence["allocations"] = [];
  for (const entry of allocations) {
    const e = asRecord(entry);
    if (!e || typeof e.invoiceId !== "string" || !e.invoiceId || !isCents(e.cents)) return null;
    readAllocations.push({ invoiceId: e.invoiceId, cents: e.cents });
  }
  const readPayments: CreditNoteMirrorEvidence["payments"] = [];
  for (const entry of payments) {
    const e = asRecord(entry);
    if (!e || typeof e.paymentId !== "string" || !e.paymentId || !isCents(e.cents)) return null;
    readPayments.push({ paymentId: e.paymentId, cents: e.cents });
  }
  const updatedAt = typeof noteUpdatedAt === "string" ? new Date(noteUpdatedAt) : null;
  if (updatedAt && Number.isNaN(updatedAt.getTime())) return null;
  if (typeof observedAt !== "string" || Number.isNaN(new Date(observedAt).getTime())) return null;
  return {
    status,
    totalCents,
    remainingCents,
    allocations: readAllocations,
    payments: readPayments,
    updatedAt,
    observedAt: new Date(observedAt),
  };
}

/**
 * The metadata to merge onto the note's links at ingest: the reading, when the
 * note funds a member's credit lot (most notes fund none, so they get nothing
 * and cost one indexed read). Built from the note the reconcile already holds;
 * it makes no Xero call. An empty object when there is nothing to keep.
 */
export async function creditNoteSpendEvidenceMetadata(
  note: XeroCreditNoteLike,
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  now: Date = new Date(),
): Promise<Record<string, StoredCreditNoteSpendEvidence>> {
  const evidence = creditNoteMirrorEvidenceFrom(note);
  if (!evidence) return {};
  const funded = await db.memberCredit.findFirst({
    where: { xeroCreditNoteId: evidence.creditNoteId, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true },
  });
  if (!funded) return {};
  return { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(evidence, now) };
}
