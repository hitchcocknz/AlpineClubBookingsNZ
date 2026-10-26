// #4421 (owner decision 26 Oct 2026, `INV-INT-028`): "RESOLVE BY HAND" ON A
// PAYMENT REFUND CREDIT-NOTE CREATE RECORDS THE NOTE THE OFFICER MADE.
//
// A FAILED refund-note create that names no note of its own is resolved only
// with the number of the credit note the officer made in Xero. The note is
// checked in Xero by the #4162 hand-made answer's own check
// (`verifyHandMadeRefundNote`) - live, a sales credit note for the payment's
// contact and exactly the row's refund amount - OUTSIDE any transaction, and
// then recorded with the resolve, under `lock(1)` and the Payment row: on the
// row (its id and number) and as the payment's tracked refund-note link
// (`writeHandMadeRefundNoteLink`, the answer's own writer), unless another
// create row or any link here already records it: one note, one refund. With
// the link, the inbound sync marks the note voided if Xero voids it, and every
// coverage reader counts it once.
//
// Refund-request notes (#4391) and every other row resolve exactly as before.
import type { Prisma } from "@prisma/client";

import {
  readPaymentHandMadeNoteExpectation,
  RESOLVED_OPERATION_LINK_KEY,
  verifyHandMadeRefundNote,
  writeHandMadeRefundNoteLink,
  type VerifiedHandMadeRefundNote,
} from "@/lib/bank-refund-void-answer";
import {
  handMadeNoteAlreadyRecordedMessage,
  RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE,
  RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE,
  RESOLVE_NOTE_RETRY_RAN_MESSAGE,
  RESOLVE_NOTE_SUPERSEDED_MESSAGE,
} from "@/lib/bank-refund-void-follow-up-copy";
import type { ClubFormat } from "@/lib/club-format";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { findQueuedLiveCopy, findRetryRunningOrSince, findSupersedingRefundNoteRun, QUEUED_LIVE_COPY_REFUSAL } from "@/lib/xero-operation-resolve-guards";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { countsTowardRefundNoteCoverage, creditNoteCreateRowsRecordingWhere } from "@/lib/xero-refund-note-status";
import { isRefundNoteCreateRow } from "@/lib/xero-resolved-in-xero-fences";

/** The fields of an operation row the shape below reads. */
export type RefundNoteResolveRow = {
  direction: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  status: string;
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
 *   (#4391), a row closed as covered by another note - or neither FAILED nor
 *   PARTIAL (the route refuses those anyway). Resolved as before.
 * - `records-note`: the row already names its note (a PARTIAL row, say).
 *   Resolved as before; that note is already on record.
 * - `refused`: a refund-note row naming no note that cannot be resolved here -
 *   a PARTIAL one (review round 2: it would count as covered with no note on
 *   record), or a FAILED one whose amount cannot be read (no note can be
 *   checked against it; Mark non-replayable stops it re-running).
 * - `asks-number`: the number of the note the officer made is required.
 *
 * The population is the coverage reader's (`isRefundNoteCreateRow`, built from
 * the constants `readResolvedRefundCreditNoteCoverage` queries with), read by
 * `parsePaymentCreditNoteRetryInput` and `countsTowardRefundNoteCoverage`, so
 * the row this asks a number of is exactly a row whose resolve counts toward
 * the payment's refund-note coverage. FAILED only (review, money F7).
 *
 * A row a later run already superseded is refused too, but that needs a read
 * (`findSupersedingRefundNoteRun`), so the route and the claim ask it, and the
 * list passes its answer in (`resolveCreditNotePrompt`).
 */
export type RefundNoteResolveShape =
  | { kind: "other" }
  | { kind: "records-note" }
  | { kind: "refused"; paymentId: string; message: string }
  | { kind: "asks-number"; paymentId: string; amountCents: number; creditsInvoiceId?: string };

export function refundNoteResolveShape(row: RefundNoteResolveRow): RefundNoteResolveShape {
  if (!isRefundNoteCreateRow(row) || !row.localId || !countsTowardRefundNoteCoverage(row)) {
    return { kind: "other" };
  }
  const recorded = parsePaymentCreditNoteRetryInput(row);
  if (recorded && recorded.kind !== "refund") return { kind: "other" };
  if (row.xeroObjectId) return { kind: "records-note" };
  if (row.status === "PARTIAL") return { kind: "refused", paymentId: row.localId, message: RESOLVE_NOTE_PARTIAL_NO_NOTE_MESSAGE };
  if (row.status !== "FAILED") return { kind: "other" };
  if (!recorded) return { kind: "refused", paymentId: row.localId, message: RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE };
  return {
    kind: "asks-number",
    paymentId: row.localId,
    amountCents: recorded.amountCents,
    ...(recorded.creditsInvoiceId ? { creditsInvoiceId: recorded.creditsInvoiceId } : {}),
  };
}

/**
 * What the Xero operations panel needs before an officer presses Resolve on a
 * row: whether it asks for the note's number and for what amount (review,
 * money F6), or why it will be refused (review, money F2) - including a row a
 * later run superseded, which the list reads for the page
 * (`findSupersededRefundNoteRowIds`) and passes in.
 */
export function resolveCreditNotePrompt(
  row: RefundNoteResolveRow,
  superseded = false,
): {
  resolveAsksCreditNoteNumber: boolean;
  resolveCreditNoteAmountCents: number | null;
  resolveRefusal: string | null;
} {
  const shape = refundNoteResolveShape(row);
  if (shape.kind === "asks-number" && superseded) {
    return { resolveAsksCreditNoteNumber: false, resolveCreditNoteAmountCents: null, resolveRefusal: RESOLVE_NOTE_SUPERSEDED_MESSAGE };
  }
  return {
    resolveAsksCreditNoteNumber: shape.kind === "asks-number",
    resolveCreditNoteAmountCents: shape.kind === "asks-number" ? shape.amountCents : null,
    resolveRefusal: shape.kind === "refused" ? shape.message : null,
  };
}

/**
 * Before any transaction: check the officer's note in Xero against the row's
 * own refund amount and the payment's contact. A provider call, so no lock is
 * held across it; the claim below re-checks under its locks what the database
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

/** The payment's refund-note link a resolve of `operationId` wrote for `creditNoteId` (`writeHandMadeRefundNoteLink`). */
function linkThisResolveWrote(operationId: string, paymentId: string, creditNoteId: string) {
  return {
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNoteId,
    role: "REFUND_CREDIT_NOTE",
    metadata: { path: [RESOLVED_OPERATION_LINK_KEY], equals: operationId },
  } satisfies Prisma.XeroObjectLinkWhereInput;
}

export type ResolveRecordingClaim = { outcome: "claimed"; resolvedAt: Date } | { outcome: "lost" };

/**
 * THE CLAIM, in one transaction, in the #4162 follow-up's order: `lock(1)`
 * FIRST - the key the hand-made answer's completion (`resolveManualRefundTask`)
 * holds for its whole transaction - then the payment's row
 * (`lockPaymentForRefundedTotal`), then the reads, then the row's
 * status-guarded claim, and the link row last (through the link funnel). So of
 * a resolve and an answer offering the same note, whichever commits second
 * sees the first and refuses: the note is recorded once.
 *
 * Under the locks: the row is re-read (still FAILED, unresolved, naming no
 * note, its amount the note's); no retry of it ran since `readAt`, when the
 * route read it (review, concurrency F1); no other create row and no link
 * records the note - except the link THIS row wrote and a withdrawal retired,
 * which the claim takes back. The mark's instant is taken here, after the
 * lock. Returns `lost` when the row changed (nothing is written then); a 409
 * refusal rolls back everything, the claim included.
 */
export async function claimResolveRecordingRefundNote(input: {
  operationId: string;
  paymentId: string;
  note: VerifiedHandMadeRefundNote;
  readAt: Date;
  reason: string;
  resolvedById: string;
}): Promise<ResolveRecordingClaim> {
  return prisma.$transaction(
    async (tx): Promise<ResolveRecordingClaim> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, input.paymentId);
      const row = await tx.xeroSyncOperation.findUnique({ where: { id: input.operationId }, select: RESOLVE_ROW_SELECT });
      const shape = row ? refundNoteResolveShape(row) : null;
      if (!row || shape?.kind !== "asks-number" || shape.paymentId !== input.paymentId || row.manuallyResolvedAt) {
        return { outcome: "lost" };
      }
      if (shape.amountCents !== input.note.amountCents) {
        throw new ManualBookingPaymentError("This refund credit note's amount changed while you were resolving it. Reload it and check before resolving.", 409);
      }
      if (await findRetryRunningOrSince(input.operationId, input.readAt, tx)) {
        throw new ManualBookingPaymentError(RESOLVE_NOTE_RETRY_RAN_MESSAGE, 409);
      }
      // Review round 2: a run that already raised this row's note, at any
      // time, and a live copy of it a self-heal queued since the route's
      // check, both re-read under the locks.
      if (await findSupersedingRefundNoteRun({ id: input.operationId, correlationKey: row.correlationKey, localId: row.localId }, tx)) {
        throw new ManualBookingPaymentError(RESOLVE_NOTE_SUPERSEDED_MESSAGE, 409);
      }
      if (await findQueuedLiveCopy({ id: input.operationId, correlationKey: row.correlationKey, entityType: row.entityType, operationType: row.operationType }, tx)) {
        throw new ManualBookingPaymentError(QUEUED_LIVE_COPY_REFUSAL, 409);
      }
      // One after the other on the interactive transaction (#1357).
      const recordedByRow = await tx.xeroSyncOperation.findFirst({
        where: { ...creditNoteCreateRowsRecordingWhere(input.note.creditNoteId), id: { not: input.operationId } },
        select: { id: true },
      });
      const links = await tx.xeroObjectLink.findMany({
        where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: input.note.creditNoteId },
        select: { localModel: true, localId: true, role: true, active: true, metadata: true },
      });
      // The link this row wrote and a withdrawal retired is this row's own,
      // taken back below; any other link records the note for something else.
      const ownWithdrawn = (link: (typeof links)[number]) =>
        link.localModel === "Payment" &&
        link.localId === input.paymentId &&
        link.role === "REFUND_CREDIT_NOTE" &&
        !link.active &&
        asRecord(link.metadata)?.[RESOLVED_OPERATION_LINK_KEY] === input.operationId;
      if (recordedByRow || !links.every(ownWithdrawn)) {
        throw new ManualBookingPaymentError(handMadeNoteAlreadyRecordedMessage(input.note.creditNoteNumber), 409);
      }
      const resolvedAt = new Date();
      const claimed = await tx.xeroSyncOperation.updateMany({
        where: {
          id: input.operationId,
          status: "FAILED",
          manuallyResolvedAt: null,
          xeroObjectId: null,
        },
        data: {
          manuallyResolvedAt: resolvedAt,
          manuallyResolvedReason: input.reason,
          manuallyResolvedById: input.resolvedById,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: input.note.creditNoteId,
          xeroObjectNumber: input.note.creditNoteNumber,
        },
      });
      if (claimed.count !== 1) return { outcome: "lost" };
      await writeHandMadeRefundNoteLink(tx, {
        paymentId: input.paymentId,
        note: input.note,
        records: { resolvedOperationId: input.operationId },
        refusals: {
          voided: `Credit note ${input.note.creditNoteNumber} was voided in Xero while it was being recorded, so nothing was recorded. A voided note cannot record a refund: make a new credit note in Xero and resolve with its number.`,
          changed: `Credit note ${input.note.creditNoteNumber} changed in Xero while it was being recorded, so nothing was recorded. Reload and try again.`,
        },
      });
      return { outcome: "claimed", resolvedAt };
    },
    { timeout: 30_000 },
  );
}

/**
 * Withdraw a resolve that recorded a note, when a retry turned out to be
 * running beside it (`findRetryOverlappingMark`): the mark, the note on the
 * row and the link it wrote go together, under the claim's own locks
 * (`lock(1)`, then the Payment row, the link last), guarded on this mark and
 * this note, so nothing a later writer put there is cleared. The link is
 * retired (inactive), not deleted; a later resolve of this row with the same
 * note takes it back.
 */
export async function withdrawResolveRecordingRefundNote(input: {
  operationId: string;
  paymentId: string;
  resolvedAt: Date;
  creditNoteId: string;
  previousXeroObjectType: string | null;
}): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await lockPaymentForRefundedTotal(tx, input.paymentId);
      const withdrawn = await tx.xeroSyncOperation.updateMany({
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
      if (withdrawn.count !== 1) return;
      await tx.xeroObjectLink.updateMany({
        where: linkThisResolveWrote(input.operationId, input.paymentId, input.creditNoteId),
        data: { active: false },
      });
    },
    { timeout: 30_000 },
  );
}

const RESOLVE_ROW_SELECT = {
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  status: true,
  queueType: true,
  requestPayload: true,
  responsePayload: true,
  correlationKey: true,
  idempotencyKey: true,
  xeroObjectId: true,
  manuallyResolvedAt: true,
} satisfies Prisma.XeroSyncOperationSelect;
