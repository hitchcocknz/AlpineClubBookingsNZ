import { readRefundRequestIdFromOperation, readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import type { BookingClassificationContext, BookingXeroRepairAction, MutableFinding } from "./xero-booking-repair-types";
import { addAction, addFinding } from "./xero-booking-repair-findings";

/** #4215 (`INV-PAY-118`): the cash this booking's payment paid back on refund requests, which no cancellation note answers. */
export function paidBackRefundRequestCents(context: Pick<BookingClassificationContext, "paidBackRefundRequests">): number {
  return context.paidBackRefundRequests.reduce((sum, request) => sum + request.amountCents, 0);
}

/**
 * #4231 (`INV-PAY-118`, D-3813-8): A REFUND REQUEST PAID BACK BEFORE THE
 * BOOKING HAD AN INVOICE. Its completion queues the request's own note only
 * against an invoice (`refundRequestCreditNoteAsk`), so once the invoice exists
 * nothing else would credit it: Xero would hold the invoice under-credited by
 * the request's cash, which the cancellation's note never answers either.
 *
 * Queued through the completion's own enqueue, for the amount the completion
 * recorded, keyed by the request, so a replay finds the request's row and
 * queues nothing. ONLY for a request with no request-note CREATE row at all and
 * no request-note link: a request whose note was raised and then voided in
 * Xero has its row, and its re-raise is an officer's decision (#4195, #4214),
 * never this arm's.
 */
export function addRefundRequestNoteNotQueuedFindings({
  findings,
  actionMap,
  context,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  context: Pick<BookingClassificationContext, "booking" | "paidBackRefundRequests" | "paymentOperations" | "paymentLinks">;
}): void {
  const payment = context.booking.payment;
  if (!payment?.xeroInvoiceId) return;
  for (const request of context.paidBackRefundRequests) {
    if (request.paymentId !== payment.id || request.amountCents <= 0) continue;
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
    if (noteAsked) continue;
    const action = addAction(actionMap, {
      key: `queue:refund-request-credit-note:${payment.id}:${request.refundRequestId}`,
      bookingId: context.booking.id,
      type: "QUEUE_REFUND_REQUEST_CREDIT_NOTE",
      description: "Queue the Xero refund credit note of a refund request paid back before the booking had an invoice.",
      safeToAutoApply: true,
      payload: { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents },
    });
    addFinding(findings, {
      code: "REFUND_REQUEST_NOTE_NOT_QUEUED",
      severity: "critical",
      summary:
        "A refund request was paid back by bank transfer before the booking had a Xero invoice, so its own refund credit note was never queued.",
      safeToAutoApply: true,
      details: { paymentId: payment.id, refundRequestId: request.refundRequestId, refundAmountCents: request.amountCents },
      actionKeys: [action.key],
    });
  }
}
