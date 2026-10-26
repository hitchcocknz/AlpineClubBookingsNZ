// #4421 (owner decision 26 Oct 2026, `INV-INT-028`): "RESOLVE BY HAND" ON A
// PAYMENT REFUND CREDIT-NOTE CREATE RECORDS THE NOTE THE OFFICER MADE.
//
// A failed refund-note create that names no note of its own is resolved only
// with the number of the credit note the officer made in Xero. The note is
// checked in Xero by the #4162 hand-made answer's own check
// (`verifyHandMadeRefundNote`) - live, a sales credit note for the payment's
// contact and exactly the row's refund amount - OUTSIDE any transaction, and
// then recorded on the row with the resolve, under `lock(1)`, unless another
// create row or any link here already records it: one note, one refund. With
// the id on the row, the hand-made answer's guard and the coverage readers see
// the note as they see any other.
//
// Refund-request notes (#4391) and every other row resolve exactly as before.
import type { Prisma } from "@prisma/client";

import { readPaymentHandMadeNoteExpectation, verifyHandMadeRefundNote, type VerifiedHandMadeRefundNote } from "@/lib/bank-refund-void-answer";
import type { ClubFormat } from "@/lib/club-format";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { countsTowardRefundNoteCoverage, creditNoteCreateRowsRecordingWhere } from "@/lib/xero-refund-note-status";

/** The fields of an operation row the shape below reads. */
export type RefundNoteResolveRow = {
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  queueType: string | null;
  requestPayload: unknown;
  responsePayload: unknown;
  correlationKey: string | null;
  idempotencyKey: string | null;
  xeroObjectId: string | null;
};

/**
 * What "Resolve by hand" asks of a row:
 * - `other`: not a payment refund-note create that counts as its own refund's
 *   note - another entity, an account-credit note, a refund request's note
 *   (#4391) or a row closed as covered by another note. Resolved as before.
 * - `records-note`: the row already names its note (a PARTIAL row, say).
 *   Resolved as before; that note is already on record.
 * - `unreadable`: a refund-note row whose amount cannot be read, so no note can
 *   be checked against it. Refused.
 * - `asks-number`: the number of the note the officer made is required.
 *
 * The population is the coverage reader's (`readResolvedRefundCreditNoteCoverage`):
 * an outbound credit-note create on a payment, queued as a refund note or with
 * no queue type, read by `parsePaymentCreditNoteRetryInput` and
 * `countsTowardRefundNoteCoverage`, so the row this asks a number of is exactly
 * a row whose resolve counts toward the payment's refund-note coverage.
 */
export type RefundNoteResolveShape =
  | { kind: "other" }
  | { kind: "records-note" }
  | { kind: "unreadable"; paymentId: string }
  | { kind: "asks-number"; paymentId: string; amountCents: number; creditsInvoiceId?: string };

export function refundNoteResolveShape(row: RefundNoteResolveRow): RefundNoteResolveShape {
  if (
    row.direction !== "OUTBOUND" ||
    row.entityType !== "CREDIT_NOTE" ||
    row.operationType !== "CREATE" ||
    row.localModel !== "Payment" ||
    !row.localId ||
    (row.queueType !== null && row.queueType !== XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE) ||
    !countsTowardRefundNoteCoverage(row)
  ) {
    return { kind: "other" };
  }
  const recorded = parsePaymentCreditNoteRetryInput(row);
  if (recorded && recorded.kind !== "refund") return { kind: "other" };
  if (row.xeroObjectId) return { kind: "records-note" };
  if (!recorded) return { kind: "unreadable", paymentId: row.localId };
  return {
    kind: "asks-number",
    paymentId: row.localId,
    amountCents: recorded.amountCents,
    ...(recorded.creditsInvoiceId ? { creditsInvoiceId: recorded.creditsInvoiceId } : {}),
  };
}

/** Whether the Xero operations panel asks for the note's number on "Resolve by hand". */
export function resolveAsksCreditNoteNumber(row: RefundNoteResolveRow): boolean {
  return refundNoteResolveShape(row).kind === "asks-number";
}

/** The refusal when the number is missing. */
export const RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE =
  "This is a refund credit note. Type the number of the credit note you made in Xero (for example CN-0123), so the app can check it and record which note it is.";

/** The refusal of a refund-note row whose amount cannot be read. */
export const RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE =
  "The app cannot read this refund credit note's amount, so it cannot check a credit note made in Xero against it. Retry it instead, or ask for help.";

/** The refusal of a note already recorded here. */
export function resolveNoteAlreadyRecordedMessage(creditNoteNumber: string): string {
  return `Credit note ${creditNoteNumber} is already recorded against another refund or booking here, so it cannot also record this one. Check the number, or make a separate credit note in Xero for this refund.`;
}

/**
 * Before any transaction: check the officer's note in Xero against the row's
 * own refund amount and the payment's contact. A provider call, so no lock is
 * held across it; the claim below re-checks under its lock what the database
 * can change. Refuses (400/409) with a message the officer reads.
 */
export async function verifyResolvedRefundNote(input: {
  shape: Extract<RefundNoteResolveShape, { kind: "asks-number" }>;
  creditNoteNumber: string;
  format: ClubFormat;
}): Promise<VerifiedHandMadeRefundNote> {
  const target = await readPaymentHandMadeNoteExpectation(input.shape.paymentId, input.shape.creditsInvoiceId);
  if (!target) {
    throw new ManualBookingPaymentError("The payment this refund credit note belongs to no longer exists, so there is nothing to check the note against.", 409);
  }
  return verifyHandMadeRefundNote({
    creditNoteNumber: input.creditNoteNumber,
    expectedAmountCents: input.shape.amountCents,
    ...target,
    format: input.format,
  });
}

/**
 * THE CLAIM, in one transaction: `lock(1)` FIRST - the key the #4162
 * completion (`resolveManualRefundTask`) holds for its whole transaction when
 * it records a hand-made note for a follow-up, on any payment - then the row
 * re-read, then the note's records here, then the status-guarded claim that
 * writes the resolve and the note together. So of a resolve and an answer
 * offering the same note, whichever commits second sees the first and refuses:
 * the note is recorded once. Returns false when the row changed since it was
 * read (a retry claimed it, another officer resolved it, it now names a note
 * of its own); nothing is written then. A note recorded elsewhere, or a row
 * whose amount moved, throws a 409 and nothing is written.
 */
export async function claimResolveRecordingRefundNote(input: {
  operationId: string;
  note: VerifiedHandMadeRefundNote;
  resolvedAt: Date;
  reason: string;
  resolvedById: string;
}): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const row = await tx.xeroSyncOperation.findUnique({ where: { id: input.operationId }, select: RESOLVE_ROW_SELECT });
      const shape = row ? refundNoteResolveShape(row) : null;
      if (!row || shape?.kind !== "asks-number" || row.manuallyResolvedAt || (row.status !== "FAILED" && row.status !== "PARTIAL")) {
        return false;
      }
      if (shape.amountCents !== input.note.amountCents) {
        throw new ManualBookingPaymentError("This refund credit note's amount changed while you were resolving it. Reload it and check before resolving.", 409);
      }
      const [recordedByRow, recordedByLink] = await Promise.all([
        tx.xeroSyncOperation.findFirst({
          where: { ...creditNoteCreateRowsRecordingWhere(input.note.creditNoteId), id: { not: input.operationId } },
          select: { id: true },
        }),
        tx.xeroObjectLink.findFirst({
          where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: input.note.creditNoteId },
          select: { id: true },
        }),
      ]);
      if (recordedByRow || recordedByLink) {
        throw new ManualBookingPaymentError(resolveNoteAlreadyRecordedMessage(input.note.creditNoteNumber), 409);
      }
      const claimed = await tx.xeroSyncOperation.updateMany({
        where: {
          id: input.operationId,
          status: { in: ["FAILED", "PARTIAL"] },
          manuallyResolvedAt: null,
          xeroObjectId: null,
        },
        data: {
          manuallyResolvedAt: input.resolvedAt,
          manuallyResolvedReason: input.reason,
          manuallyResolvedById: input.resolvedById,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: input.note.creditNoteId,
          xeroObjectNumber: input.note.creditNoteNumber,
        },
      });
      return claimed.count === 1;
    },
    { timeout: 30_000 },
  );
}

/**
 * Withdraw a resolve that recorded a note, when a retry turned out to be
 * running beside it (`findRetryOverlappingMark`): the mark and the note go
 * together, guarded on this mark and this note, so nothing a later writer put
 * there is cleared.
 */
export async function withdrawResolveRecordingRefundNote(input: {
  operationId: string;
  resolvedAt: Date;
  creditNoteId: string;
  previousXeroObjectType: string | null;
}): Promise<void> {
  await prisma.xeroSyncOperation.updateMany({
    where: { id: input.operationId, manuallyResolvedAt: input.resolvedAt, xeroObjectId: input.creditNoteId },
    data: {
      manuallyResolvedAt: null,
      manuallyResolvedReason: null,
      manuallyResolvedById: null,
      xeroObjectType: input.previousXeroObjectType,
      xeroObjectId: null,
      xeroObjectNumber: null,
    },
  });
}

const RESOLVE_ROW_SELECT = {
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  queueType: true,
  requestPayload: true,
  responsePayload: true,
  correlationKey: true,
  idempotencyKey: true,
  xeroObjectId: true,
  status: true,
  manuallyResolvedAt: true,
} satisfies Prisma.XeroSyncOperationSelect;
