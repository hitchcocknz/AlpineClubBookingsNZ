import type { PaymentStatus } from "@prisma/client";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";

/**
 * #3635: THE ONE DECISION about a late capture on a cancelled booking - is it
 * refunded, awaiting a treasurer, or kept, and what does Xero owe it - plus the
 * names its record uses. Pure; every caller loads its own facts and asks here:
 * the waiting-invoice reaper and the late-capture release (through
 * `lateCaptureRefundState`), the dismissal (`late-capture-kept-xero.ts`), the
 * kept-invoice worker at send time (`xero-kept-late-capture-invoice.ts`) and
 * the booking-vs-Xero repair tool (`INV-SSOT`, `INV-PAY-110`).
 */

/** The link roles a kept capture's own invoice and its Stripe payment write. */
export const KEPT_LATE_CAPTURE_INVOICE_ROLE = "KEPT_LATE_CAPTURE_INVOICE";
export const KEPT_LATE_CAPTURE_PAYMENT_ROLE = "KEPT_LATE_CAPTURE_PAYMENT";

export type LateCaptureRefundState = "refunded" | "awaiting-decision" | "kept";

export type LateCaptureDecision = {
  state: LateCaptureRefundState;
  /**
   * What Xero owes this capture as its receipt: the GROSS captured cents when
   * it is kept - or its approved refund was closed as paid another way - and
   * was captured, else 0. Gross, the way a card receipt is
   * recorded (orchestrator decision 29 Sep 2026 on #3635): any refund, from
   * the dashboard or on approval, is answered by its own refund credit note,
   * so netting it here as well would count it twice.
   */
  recordCents: number;
};

/**
 * - A #3639 approval task, when one owns the capture, decides: OPEN is
 *   awaiting (nothing may be sent or retired), COMPLETED refunded (the
 *   approval is the refund), DISMISSED kept (owner decision 29 Sep 2026).
 * - With no task, the webhook's own routing: a CANCELLED booking's late capture
 *   or a superseded intent's is refunded by design; anything else is kept.
 * - #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit"): an
 *   approval whose card refund Stripe gave up on, closed as paid another way
 *   (`refundClosedPaidAnotherWay`), is still refunded - the member has the
 *   money back - but Stripe never paid it out, so the capture is still in the
 *   Stripe account and Xero owes its receipt, GROSS, as for a kept one. The
 *   bank transfer is the close's own refund note against that receipt.
 */
export function decideLateCapture(input: {
  taskStatus: "OPEN" | "COMPLETED" | "DISMISSED" | null;
  bookingStatus: string | null | undefined;
  superseded: boolean;
  capture: { status: PaymentStatus; amountCents: number } | null;
  /** The approval's card refund was closed as paid another way (`findLateCaptureRefundPaidAnotherWay`). */
  refundClosedPaidAnotherWay?: boolean;
}): LateCaptureDecision {
  let state: LateCaptureRefundState;
  if (input.taskStatus === "OPEN") state = "awaiting-decision";
  else if (input.taskStatus === "COMPLETED") state = "refunded";
  else if (input.taskStatus === "DISMISSED") state = "kept";
  else if (isLateCaptureRefundedBookingStatus(input.bookingStatus) || input.superseded) {
    state = "refunded";
  } else state = "kept";
  const receiptOwed =
    state === "kept" || (input.taskStatus === "COMPLETED" && input.refundClosedPaidAnotherWay === true);
  const recordCents =
    receiptOwed && input.capture && isCapturedTransactionStatus(input.capture.status)
      ? Math.max(input.capture.amountCents, 0)
      : 0;
  return { state, recordCents };
}

/**
 * DOES THE BOOKING HAVE ITS ORIGINAL XERO INVOICE? (#3635 round-3 nit, one
 * reading for the dismissal and the repair tool.) The payment's recorded
 * invoice id, or an active PRIMARY_INVOICE link on the payment.
 */
export function bookingHasPrimaryXeroInvoice(input: {
  paymentXeroInvoiceId: string | null | undefined;
  paymentLinks: ReadonlyArray<{ role: string; xeroObjectType: string; active: boolean }>;
}): boolean {
  return (
    Boolean(input.paymentXeroInvoiceId) ||
    input.paymentLinks.some(
      (link) => link.active && link.xeroObjectType === "INVOICE" && link.role === "PRIMARY_INVOICE",
    )
  );
}

/**
 * WHICH DOCUMENT RECORDS A KEPT CAPTURE, first cut. The booking's own payment,
 * and a change payment on a booking Xero never invoiced (#3635 review F3), get
 * the kept-capture invoice, which needs no original. A change payment on a
 * booking whose original invoice exists is decided by what the change's own
 * Xero records show (#4324, {@link keptChangeCaptureRoute}).
 */
export function keptLateCaptureRecordRoute(input: {
  captureKind: "PRIMARY" | "ADDITIONAL";
  bookingHasPrimaryInvoice: boolean;
}): "by-change-evidence" | "kept-invoice" {
  return input.captureKind === "ADDITIONAL" && input.bookingHasPrimaryInvoice
    ? "by-change-evidence"
    : "kept-invoice";
}

/**
 * #4324: what the change a kept capture pays for shows in Xero, read under the
 * per-anchor supplementary-invoice lock (`readKeptChangeCaptureEvidence`).
 */
export type KeptChangeCaptureEvidence = {
  /**
   * A supplementary invoice naming the capture's intent that the late-success
   * release answers from: in any status but CANCELLED, or retired by the
   * reaper (`STALE_WAITING_PAYMENT`, or its captured and covered stamps).
   */
  answeredByChangeInvoice: boolean;
  /** The change the capture pays for (`captureChangeId`); null when none can be read. */
  changeId: string | null;
  /** The change settled against the primary invoice (#3980's marker). */
  settledAgainstPrimary: boolean;
  /**
   * The change's own supplementary invoices, never the #3980 gap invoice:
   * `none` never asked for, `live` one not CANCELLED (or linked in Xero),
   * `withdrawn` every one CANCELLED.
   */
  changeInvoices: "none" | "live" | "withdrawn";
};

export type KeptChangeCaptureRoute = "change-invoice" | "receipt" | "kept-invoice" | "change-unknown";

/**
 * #4324 (owner decision 25 Oct 2026, Q1 "split on the evidence";
 * `INV-PAY-140`): WHICH DOCUMENT RECORDS A KEPT CHANGE CAPTURE on a cancelled
 * booking whose primary invoice exists. Pure; decided once, under the
 * change's anchor lock (`queueKeptLateCaptureRecord`), and read by the repair
 * tool's finding.
 *
 * - `change-invoice`: a change invoice already answers the capture; the
 *   late-success release sends, revives or alerts on it.
 * - `receipt`: the primary invoice bills the change (the change settled
 *   against it, or never had a supplementary invoice), or the change's own
 *   invoice is live. The capture's own receipt records it against the invoice
 *   that bills it, capped at what Xero shows due (`INV-PAY-139`).
 * - `kept-invoice`: the change's supplementary invoice was withdrawn or
 *   retired, so nothing bills it; the kept-capture invoice does (`INV-PAY-110`).
 * - `change-unknown`: no change can be read from the capture; nothing is
 *   queued, and the repair tool names it for an officer.
 */
export function keptChangeCaptureRoute(evidence: KeptChangeCaptureEvidence): KeptChangeCaptureRoute {
  if (evidence.answeredByChangeInvoice) return "change-invoice";
  if (evidence.changeId === null) return "change-unknown";
  if (evidence.settledAgainstPrimary) return "receipt";
  return evidence.changeInvoices === "withdrawn" ? "kept-invoice" : "receipt";
}

/**
 * HAS THIS KEPT CAPTURE'S INVOICE ALREADY BEEN ASKED FOR? A kept-capture
 * invoice row anchored on its approval task, in any state but CANCELLED. A
 * FAILED or PARTIAL one counts: it is retried, never replaced. The enqueue and
 * the repair tool both ask this, and nothing else spells it.
 */
export function keptLateCaptureInvoiceAsked(
  taskOperations: ReadonlyArray<{ queueType: string | null; status: string }>,
): boolean {
  return taskOperations.some(
    (operation) =>
      operation.queueType === XERO_OUTBOX_KEPT_LATE_CAPTURE_INVOICE_TYPE &&
      operation.status !== "CANCELLED",
  );
}

/**
 * #3924 round 8 (money review): MAY THIS FAILED RECEIPT ROW HAVE REACHED XERO?
 * The worker writes the invoice it is about to send onto the row
 * (`invoices`, beside the queued payload) before it calls Xero, and records
 * the receipt's Stripe payment, with its link, after Xero returned the
 * invoice. Either one means `createInvoices` was attempted: Xero may hold the
 * receipt though the app never linked it, and running the row again could
 * raise a second. Such a row is never put back to run automatically - not by a
 * close, not by the repair tool - and is left for an officer, who checks Xero
 * first. The enqueue and the repair tool both ask this, and nothing else
 * spells it.
 */
export function keptReceiptMayHaveReachedXero(input: {
  requestPayload: unknown;
  paymentLinked: boolean;
}): boolean {
  return input.paymentLinked || xeroCreateCallAttempted(input.requestPayload);
}

/**
 * #3924 round 10: DID THIS INVOICE ROW ATTEMPT `createInvoices`? The kept
 * receipt's worker and a change's supplementary invoice worker
 * (`createXeroSupplementaryInvoice`) both write the invoice they are about to
 * send onto the row (`invoices`, beside the queued payload) before they call
 * Xero, so a FAILED row carrying it may be in Xero though the app never
 * linked it. The one spelling of that test.
 */
export function xeroCreateCallAttempted(requestPayload: unknown): boolean {
  return (
    typeof requestPayload === "object" &&
    requestPayload !== null &&
    !Array.isArray(requestPayload) &&
    Array.isArray((requestPayload as Record<string, unknown>).invoices)
  );
}
