import "server-only";

import { createAuditLog } from "@/lib/audit";
import { reRecordNoteRowsWhere } from "@/lib/bank-refund-re-record-note";
import { RE_RECORD_REFUSAL_MESSAGES } from "@/lib/bank-refund-void-copy";
import {
  readBankRefundVoidPaymentId,
  readBankRefundVoidUnderLock,
  readReRecordNoteState,
} from "@/lib/bank-refund-void-report";
import {
  BankRefundVoidResolutionError,
  readPaymentFigures,
  voidedNoteDocument,
} from "@/lib/bank-refund-void-resolution";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import logger from "@/lib/logger";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { enqueueXeroRefundCreditNoteOperation, kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { findBlockingRefundCreditNoteOperationId } from "@/lib/xero-refund-note-link-repair";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): RETRY A RECORD-AGAIN
 * WHOSE OWN NOTE FAILED OR LANDED SHORT. The same resolution, so the note's Xero
 * key (`re-record:<id>:<own cover>`) is the one the failed attempt used and
 * Xero hands back any note that attempt raised; sized from the record less the
 * notes its rows minted, it never raises a second note for the same money.
 * Locks as the record-again's (`bank-refund-void-resolution.ts`): `lock(1)`,
 * then the Payment row, then the resolution and its note's state re-read. The
 * claim is the status-guarded retirement of its own failed attempts
 * (`replayable` off), then it refuses while any other refund-note create could
 * still mint, and queues one row; the worker is kicked after the commit.
 */

export interface RetryBankTransferRefundReRecordInput {
  /** The voided note's link id (`BankRefundVoidItem.linkId`). */
  linkId: string;
  /** An optional note for the audit row. */
  note?: string | null;
  actingMemberId: string;
}

export interface RetryBankTransferRefundReRecordResult {
  resolutionId: string;
  paymentId: string;
  bookingId: string;
  /** The record-again's own failed attempts retired in favour of the new row. */
  retiredOperationIds: string[];
  noteOperationId: string;
}

/** Why a retry is refused, by the state its record-again's note is in. */
const RETRY_STATE_REFUSALS = {
  landed: "This record-again's credit note already reached Xero, so there is nothing to retry.",
  "on-its-way": "This record-again's credit note is already on its way to Xero. Wait for it, then refresh.",
  "voided-again": "Xero voided this record-again's credit note too. Answer that note on its own row instead.",
} as const;

/** Retry a record-again whose own note failed or landed short. See the module comment. */
export async function retryBankTransferRefundReRecord(
  input: RetryBankTransferRefundReRecordInput,
): Promise<RetryBankTransferRefundReRecordResult> {
  const auditNote = normaliseManualPaymentNote(input.note);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const paymentId = await readBankRefundVoidPaymentId(tx, input.linkId);
    if (!paymentId) throw new BankRefundVoidResolutionError("Voided refund note not found.", 404);
    // `lock(1)` is held; the Payment row before anything about it is read.
    await lockPaymentForRefundedTotal(tx, paymentId);
    const voided = await readBankRefundVoidUnderLock(tx, input.linkId, now);
    if (!voided || voided.paymentId !== paymentId) {
      throw new BankRefundVoidResolutionError("This is not a voided bank-transfer refund note. The list has been refreshed.", 404);
    }
    const resolution = await tx.bankRefundVoidResolution.findUnique({
      where: { paymentId_voidedCreditNoteId: { paymentId, voidedCreditNoteId: voided.link.xeroObjectId } },
      select: { id: true, outcome: true, amountCents: true, noteOperationId: true },
    });
    if (!resolution || resolution.outcome !== "RE_RECORDED") {
      throw new BankRefundVoidResolutionError("Only a refund recorded again can be retried.", 409);
    }
    const state = await readReRecordNoteState(tx, paymentId, resolution);
    if (state !== "failed") throw new BankRefundVoidResolutionError(RETRY_STATE_REFUSALS[state], 409);

    // The claim: the record-again's own failed attempts stop being replayable,
    // status-guarded on what was read, so only the row queued below can mint.
    const rowsWhere = reRecordNoteRowsWhere(paymentId, resolution.id, resolution.noteOperationId);
    const retired =
      (await tx.xeroSyncOperation.findMany({
        where: { AND: [rowsWhere, { status: { in: ["FAILED", "PARTIAL"] }, replayable: true }] },
        select: { id: true },
      })) ?? [];
    if (retired.length > 0) {
      const claimed = await tx.xeroSyncOperation.updateMany({
        where: { id: { in: retired.map((row) => row.id) }, status: { in: ["FAILED", "PARTIAL"] }, replayable: true },
        data: { replayable: false },
      });
      if (claimed.count !== retired.length) {
        throw new BankRefundVoidResolutionError("This record-again's credit note changed while you were retrying it - refresh and try again.", 409);
      }
    }
    // Nothing else may mint a refund note on this payment meanwhile (#3880).
    if (await findBlockingRefundCreditNoteOperationId(paymentId, tx)) {
      throw new BankRefundVoidResolutionError(RE_RECORD_REFUSAL_MESSAGES["note-in-flight"], 409);
    }

    const { booking } = await readPaymentFigures(tx, paymentId);
    // The same record, so the same key: sized from it less its own notes.
    const document = await voidedNoteDocument(tx, paymentId, voided.link.xeroObjectId);
    const queued = await enqueueXeroRefundCreditNoteOperation(paymentId, resolution.amountCents, {
      ...document,
      createdByMemberId: input.actingMemberId,
      reRecordId: resolution.id,
      store: tx,
    });
    if (!queued.queueOperationId) {
      throw new BankRefundVoidResolutionError(`No refund credit note could be queued: ${queued.message}`, 409);
    }

    await createAuditLog(
      {
        action: "booking-payment.bank-refund.re-record-retried",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: booking.id,
        entityType: "BankRefundVoidResolution",
        entityId: resolution.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Recorded-again bank-transfer refund on booking ${formatBookingReference(booking.id)}: its credit note queued again under the same record`,
        ...(auditNote ? { details: auditNote } : {}),
        metadata: {
          paymentId,
          voidedCreditNoteId: voided.link.xeroObjectId,
          retiredOperationIds: retired.map((row) => row.id),
          noteOperationId: queued.queueOperationId,
        },
      },
      tx,
    );

    return {
      resolutionId: resolution.id,
      paymentId,
      bookingId: booking.id,
      retiredOperationIds: retired.map((row) => row.id),
      noteOperationId: queued.queueOperationId,
    };
  });

  await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error: unknown) =>
    logger.error({ err: error, resolutionId: result.resolutionId }, "Failed to kick the Xero outbox after a record-again retry"),
  );
  return result;
}
