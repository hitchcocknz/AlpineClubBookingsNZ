import { readRefundRequestIdFromOperation, readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";
import type { BookingClassificationContext, BookingXeroRepairAction, MutableFinding } from "./xero-booking-repair-types";
import { addAction, addFinding, buildManualReviewAction } from "./xero-booking-repair-findings";
import { getKnownModificationRefundTotalCents } from "./xero-booking-repair-analysis";
import { readJsonRecord, readStoredXeroAmountCents } from "./xero-booking-repair-utils";

/** #4215 (`INV-PAY-118`): the cash this booking's payment paid back on refund requests, which no cancellation note answers. */
export function paidBackRefundRequestCents(context: Pick<BookingClassificationContext, "paidBackRefundRequests">): number {
  return context.paidBackRefundRequests.reduce((sum, request) => sum + request.amountCents, 0);
}

type ArmContext = Pick<
  BookingClassificationContext,
  "booking" | "paidBackRefundRequests" | "paymentOperations" | "paymentLinks" | "cancelledRefundNoteIds" | "modificationOperationsById"
>;

/**
 * #4231 lens F1: what the payment's OWN refund notes (`REFUND_CREDIT_NOTE`:
 * the cancellation's, and any per-refund note) record, live or still to be
 * sent - never a request's note, an account-credit note, or a note Xero
 * voided (it covers nothing). Null when one of them records no readable
 * amount, or the payment names a note nothing local records: a person reads it.
 */
function ownRefundNotesRecordedCents(context: ArmContext): number | null {
  const payment = context.booking.payment!;
  const amounts = new Map<string, number | null>();
  for (const link of context.paymentLinks) {
    if (link.xeroObjectType !== "CREDIT_NOTE" || link.role !== "REFUND_CREDIT_NOTE") continue;
    if (context.cancelledRefundNoteIds.has(link.xeroObjectId) || isRefundCreditNoteLinkCancelledInXero(link.metadata)) continue;
    amounts.set(link.xeroObjectId, readStoredXeroAmountCents(link.metadata));
  }
  for (const operation of context.paymentOperations) {
    if (operation.entityType !== "CREDIT_NOTE" || operation.operationType !== "CREATE" || operation.status === "CANCELLED") continue;
    if (readRefundRequestIdFromOperation(operation) !== null) continue;
    if ((operation.queueType ?? readJsonRecord(operation.requestPayload)?.queueType) !== XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE) continue;
    const noteId = operation.xeroObjectId ?? `operation:${operation.id}`;
    if (context.cancelledRefundNoteIds.has(noteId)) continue;
    // A link that records no figure takes the row's; a link's own figure wins.
    if (amounts.get(noteId) == null) amounts.set(noteId, readStoredXeroAmountCents(operation.requestPayload));
  }
  if (payment.xeroRefundCreditNoteId && !amounts.has(payment.xeroRefundCreditNoteId) && !context.cancelledRefundNoteIds.has(payment.xeroRefundCreditNoteId)) {
    return null;
  }
  let total = 0;
  for (const amountCents of amounts.values()) {
    if (amountCents === null || amountCents < 0) return null;
    total += amountCents;
  }
  return total;
}

/**
 * #4231 (`INV-PAY-118`, D-3813-8): A REFUND REQUEST PAID BACK BEFORE THE
 * BOOKING HAD AN INVOICE. Its completion queues the request's own note only
 * against an invoice (`refundRequestCreditNoteAsk`), so once the invoice exists
 * nothing else would credit it: Xero would hold the invoice under-credited by
 * the request's cash, which the cancellation's note never answers either.
 *
 * Offered through the completion's own enqueue, for the amount the completion
 * recorded, keyed by the request, so a replay finds the request's row and
 * queues nothing. ONLY for a request with no request-note CREATE row at all and
 * no request-note link: a request whose note was raised and then voided in
 * Xero has its row, and its re-raise is an officer's decision (#4195, #4214),
 * never this arm's.
 *
 * Lens F1/F2: NEVER auto-applied. Before #4231 the tool, or an officer by hand,
 * could size the cancellation's note to the whole refunded total, the
 * request's cash folded in, and nothing local records a credit raised by hand
 * in Xero. So the officer checks Xero and applies it by its key
 * (`--apply-action`); and where the payment's own refund notes already record
 * more than the cash that is neither an edit's nor a request's - measured
 * against the charge rows when those are lower, so a total the recount already
 * raised by the folded cash still shows it - no action is offered at all: a
 * person corrects the cancellation's note first.
 */
export function addRefundRequestNoteNotQueuedFindings({
  findings,
  actionMap,
  context,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  context: ArmContext;
}): void {
  const payment = context.booking.payment;
  if (!payment?.xeroInvoiceId) return;
  const missing = context.paidBackRefundRequests.filter((request) => {
    if (request.paymentId !== payment.id || request.amountCents <= 0) return false;
    const noteAsked =
      context.paymentOperations.some(
        (operation) =>
          operation.entityType === "CREDIT_NOTE" &&
          operation.operationType === "CREATE" &&
          readRefundRequestIdFromOperation(operation) === request.refundRequestId,
      ) ||
      context.paymentLinks.some(
        (link) =>
          link.role === REFUND_REQUEST_CREDIT_NOTE_ROLE && readRefundRequestIdFromPayload(link.metadata) === request.refundRequestId,
      );
    return !noteAsked;
  });
  if (missing.length === 0) return;

  const rowsRefundedCents = payment.transactions.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  const refundedCents = payment.transactions.length > 0 ? Math.min(payment.refundedAmountCents, rowsRefundedCents) : payment.refundedAmountCents;
  const ownCashCents =
    refundedCents - getKnownModificationRefundTotalCents(context.booking, context.modificationOperationsById) - paidBackRefundRequestCents(context);
  const recordedCents = ownRefundNotesRecordedCents(context);
  if (recordedCents === null || recordedCents > ownCashCents) {
    const reason =
      recordedCents === null
        ? "A refund request paid back before the booking had a Xero invoice has no credit note of its own, but a refund credit note on this payment records no readable amount: check in Xero whether it already holds the request's cash before raising the request's note."
        : "A refund request paid back before the booking had a Xero invoice has no credit note of its own, and the payment's refund credit notes already record more than the cancellation's own cash: the request's cash was most likely folded into the cancellation's note. Correct that note in Xero (edit it in place; never void it) before raising the request's own note, or Xero credits the request twice.";
    const action = addAction(actionMap, buildManualReviewAction(context.booking.id, reason));
    addFinding(findings, {
      code: "REFUND_REQUEST_NOTE_NOT_QUEUED",
      severity: "manual_review",
      summary: reason,
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        refundRequestIds: missing.map((request) => request.refundRequestId),
        requestCashCents: missing.reduce((sum, request) => sum + request.amountCents, 0),
        refundNotesRecordedCents: recordedCents,
        cancellationOwnCashCents: ownCashCents,
      },
      actionKeys: [action.key],
    });
    return;
  }

  for (const request of missing) {
    const action = addAction(actionMap, {
      key: `queue:refund-request-credit-note:${payment.id}:${request.refundRequestId}`,
      bookingId: context.booking.id,
      type: "QUEUE_REFUND_REQUEST_CREDIT_NOTE",
      description:
        "Queue the Xero refund credit note of a refund request paid back before the booking had an invoice, once an officer has checked Xero holds no credit raised by hand for it.",
      safeToAutoApply: false,
      payload: { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents },
    });
    addFinding(findings, {
      code: "REFUND_REQUEST_NOTE_NOT_QUEUED",
      severity: "critical",
      summary:
        "A refund request was paid back by bank transfer before the booking had a Xero invoice, so its own refund credit note was never queued. Check Xero for a credit raised by hand for it before applying this action.",
      safeToAutoApply: false,
      details: { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents },
      actionKeys: [action.key],
    });
  }
}
