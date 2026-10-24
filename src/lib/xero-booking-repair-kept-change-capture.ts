/**
 * #4324 (owner decision 25 Oct 2026, Q3 "apply automatically";
 * `INV-PAY-141`): THE REPAIR TOOL'S HALF OF A KEPT CHANGE CAPTURE - a late
 * card payment for a booking change that a treasurer kept on a cancelled
 * booking whose primary Xero invoice exists, which Xero never recorded.
 *
 * Before #4324 the keep released the change's supplementary invoice, and where
 * none waited on the capture nothing recorded it. This names each such
 * capture in the dry run, with the document that would record it
 * (`keptChangeCaptureRoute`): a payment on the invoice that bills the change
 * (its own receipt, `INV-PAY-139`), or the kept-capture invoice where nothing
 * bills it (`INV-PAY-110`). `--apply` records it automatically: the action
 * runs the keep's own decision (`planKeptLateCaptureXeroRecord`) under the
 * approval task's row lock and the change's anchor lock, which reads the
 * evidence again there and finds the capture's existing record first, so each
 * capture is recorded exactly once whatever the snapshot said.
 *
 * Never where a change invoice already answers the capture (the late-success
 * release owns it), or where another document records it
 * (`readCaptureRecorder`). A capture no change can be read from, or on a
 * booking not paid by card, is named for an officer and never applied.
 */
import type { PaymentStatus } from "@prisma/client";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE, captureChangeId } from "@/lib/additional-capture-receipt-link";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE } from "@/lib/additional-capture-xero-receipt";
import { readCaptureRecorder, type RecorderStore } from "@/lib/additional-capture-recorder";
import { readKeptChangeCaptureEvidence } from "@/lib/late-capture-kept-xero";
import {
  decideLateCapture,
  keptChangeCaptureRoute,
  type KeptChangeCaptureEvidence,
  type KeptChangeCaptureRoute,
} from "@/lib/late-capture-kept-xero-rules";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  xeroOperationSelect,
  type BookingXeroRepairAction,
  type MutableFinding,
  type XeroOperationRecord,
} from "./xero-booking-repair-types";
import { addAction, addFinding, buildManualReviewAction, buildRetryAction } from "./xero-booking-repair-findings";
import { getBlockingOperation } from "./xero-booking-repair-object-resolution";
import type { RepairDependencies } from "./xero-booking-repair-deps";

/** What the repair pass knows about one kept change capture. */
export type KeptChangeCaptureRepairEvidence = {
  evidence: KeptChangeCaptureEvidence;
  route: KeptChangeCaptureRoute;
  /** The capture's receipt rows (`ADDITIONAL_CAPTURE_RECEIPT`), newest first. */
  receiptOperations: XeroOperationRecord[];
  /** The receipt's Xero payment is linked. */
  receiptLinked: boolean;
  /** Another writer records the capture (`readCaptureRecorder`), read only where no receipt row exists. */
  recordedElsewhere: boolean;
};

type LoadBooking = {
  id: string;
  status: string;
  payment: {
    xeroInvoiceId: string | null;
    transactions: Array<{
      id: string | null;
      kind: string;
      stripePaymentIntentId: string | null;
      bookingModificationId?: string | null;
      reason?: string | null;
    }>;
  } | null;
};

/**
 * Read-only: the evidence for every kept change capture on a cancelled booking
 * whose primary invoice exists, by booking and then intent.
 */
export async function loadKeptChangeCaptureEvidence(
  store: RecorderStore & Pick<RepairDependencies["prisma"], "xeroObjectLink">,
  bookings: readonly LoadBooking[],
  keptIntentsByBookingId: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
): Promise<Map<string, Map<string, KeptChangeCaptureRepairEvidence>>> {
  const byBooking = new Map<string, Map<string, KeptChangeCaptureRepairEvidence>>();
  for (const booking of bookings) {
    const primaryInvoiceId = booking.payment?.xeroInvoiceId;
    const kept = keptIntentsByBookingId.get(booking.id);
    if (booking.status !== "CANCELLED" || !booking.payment || !primaryInvoiceId || !kept) continue;
    const captures = booking.payment.transactions.filter(
      (row): row is typeof row & { id: string; stripePaymentIntentId: string } =>
        row.kind === "ADDITIONAL" && row.id !== null && row.stripePaymentIntentId !== null && kept.has(row.stripePaymentIntentId),
    );
    const found = new Map<string, KeptChangeCaptureRepairEvidence>();
    for (const capture of captures) {
      const changeId = captureChangeId({ bookingModificationId: capture.bookingModificationId ?? null, reason: capture.reason ?? null });
      const [evidence, receiptOperations, link] = await Promise.all([
        readKeptChangeCaptureEvidence(store, { paymentIntentId: capture.stripePaymentIntentId, changeId }),
        store.xeroSyncOperation.findMany({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
          },
          select: xeroOperationSelect,
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        }) as Promise<XeroOperationRecord[]>,
        store.xeroObjectLink.findFirst({
          where: {
            localModel: "PaymentTransaction",
            localId: capture.id,
            role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
            active: true,
          },
          select: { id: true },
        }),
      ]);
      const hasReceiptRow = receiptOperations.some((operation) => operation.status !== "CANCELLED");
      const recordedElsewhere =
        !hasReceiptRow &&
        link === null &&
        (
          await readCaptureRecorder(
            { bookingId: booking.id, primaryInvoiceId, paymentIntentId: capture.stripePaymentIntentId, bookingModificationId: changeId },
            store,
          )
        ).kind !== "receipt";
      found.set(capture.stripePaymentIntentId, {
        evidence,
        route: keptChangeCaptureRoute(evidence),
        receiptOperations,
        receiptLinked: link !== null,
        recordedElsewhere,
      });
    }
    if (found.size > 0) byBooking.set(booking.id, found);
  }
  return byBooking;
}

const UNKNOWN_CHANGE_SUMMARY =
  "A late card payment a treasurer kept on this cancelled booking names no booking change, so which Xero invoice bills it cannot be told, and Xero does not record it. Check Xero, record the payment by hand against the invoice that bills it, or raise one, then mark it done.";

const NOT_A_CARD_BOOKING_SUMMARY =
  "A late card payment a treasurer kept on this cancelled booking is not recorded in Xero, and the booking was paid by internet banking, so the app records no card payment against its invoice. Record it by hand in Xero.";

const REFUSED_SUMMARY =
  "A late card payment a treasurer kept on this cancelled booking could not be recorded against the Xero invoice that bills it. Its Xero operation says why; record it by hand in Xero and mark the operation resolved, or fix the cause and retry it.";

/**
 * The finding for one kept change capture, or none. `kept` is the capture's
 * approval task; the caller has already left out a capture whose kept-capture
 * invoice was asked for (that has its own retry and resolved findings).
 */
export function addKeptChangeCaptureFinding({
  findings,
  actionMap,
  booking,
  payment,
  transaction,
  kept,
  found,
}: {
  findings: MutableFinding[];
  actionMap: Map<string, BookingXeroRepairAction>;
  booking: { id: string };
  payment: { id: string; source: string | null };
  transaction: { stripePaymentIntentId: string; status: PaymentStatus; amountCents: number };
  kept: { taskId: string };
  found: KeptChangeCaptureRepairEvidence | undefined;
}): void {
  if (!found || found.route === "change-invoice") return;
  const { recordCents } = decideLateCapture({
    taskStatus: "DISMISSED",
    bookingStatus: "CANCELLED",
    superseded: false,
    capture: transaction,
  });
  if (recordCents === 0) return;
  const paymentIntentId = transaction.stripePaymentIntentId;
  const details = {
    paymentId: payment.id,
    manualRefundTaskId: kept.taskId,
    paymentIntentId,
    bookingModificationId: found.evidence.changeId,
    capturedCents: recordCents,
    recordedBy:
      found.route === "kept-invoice"
        ? "KEPT_LATE_CAPTURE_INVOICE"
        : found.route === "receipt"
          ? "ADDITIONAL_CAPTURE_RECEIPT"
          : null,
  };
  const manualReview = (summary: string, extra: Record<string, unknown> = {}) => {
    const action = addAction(actionMap, buildManualReviewAction(booking.id, summary));
    addFinding(findings, {
      code: "KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO",
      severity: "manual_review",
      summary,
      safeToAutoApply: false,
      details: { ...details, ...extra },
      actionKeys: [action.key],
    });
  };
  if (found.route === "change-unknown") return manualReview(UNKNOWN_CHANGE_SUMMARY);

  // Its receipt, whichever route the evidence reads now, is its record.
  if (found.receiptLinked || found.recordedElsewhere) return;
  if (found.receiptOperations.some((operation) => operation.status !== "CANCELLED")) {
    const blocking = getBlockingOperation(found.receiptOperations, "PAYMENT", "CREATE", {
      payloadQueueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
    });
    if (blocking?.kind === "retryable" && blocking.operation.lastErrorCode !== ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE) {
      const action = addAction(actionMap, buildRetryAction(booking.id, blocking));
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary: "A failed Xero operation recording a late card payment a treasurer kept needs retrying.",
        safeToAutoApply: action.safeToAutoApply,
        details: { ...details, operationId: blocking.operation.id, operationStatus: blocking.operation.status },
        actionKeys: [action.key],
      });
    } else if (blocking && blocking.kind !== "resolved" && ["FAILED", "PARTIAL"].includes(blocking.operation.status)) {
      manualReview(REFUSED_SUMMARY, { operationId: blocking.operation.id, reason: blocking.operation.lastErrorMessage });
    }
    // Queued, running, done, or resolved by an officer in Xero.
    return;
  }
  if (found.route === "receipt" && payment.source !== "STRIPE") return manualReview(NOT_A_CARD_BOOKING_SUMMARY);

  const action = addAction(actionMap, {
    key: `queue:kept-late-capture-record:${kept.taskId}`,
    bookingId: booking.id,
    type: "QUEUE_KEPT_LATE_CAPTURE_RECORD",
    description:
      found.route === "receipt"
        ? "Record the kept card payment as a payment on the Xero invoice that bills its booking change, capped at what Xero shows still due. The keep's own decision runs again under its locks first, so it is recorded once."
        : "Queue the Xero invoice, paid from the Stripe account on the capture day, that records a kept card payment for a booking change nothing in Xero bills. The keep's own decision runs again under its locks first, so it is recorded once.",
    safeToAutoApply: true,
    payload: {
      manualRefundTaskId: kept.taskId,
      bookingId: booking.id,
      paymentIntentId,
    },
  });
  addFinding(findings, {
    code: "KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO",
    severity: "critical",
    summary:
      found.route === "receipt"
        ? "A treasurer kept a late card payment for a booking change on this cancelled booking, and Xero does not record it: the booking's Xero invoice still shows that change as owing though Stripe holds the money."
        : "A treasurer kept a late card payment for a booking change on this cancelled booking, and Xero does not record it: nothing in Xero bills that change, so the kept-payment invoice records it.",
    safeToAutoApply: true,
    details,
    actionKeys: [action.key],
  });
}

/**
 * Applies the finding's action: the keep's own decision, on a transaction of
 * its own, under the approval task's row lock and then the change's anchor
 * lock - it reads the task (still DISMISSED), the capture's existing record
 * and the evidence again there, so a stale snapshot records nothing twice.
 */
export async function applyKeptChangeCaptureRecordAction(
  action: BookingXeroRepairAction,
  deps: Pick<RepairDependencies, "prisma" | "planKeptLateCaptureXeroRecord">,
): Promise<void> {
  const clubZone = await readClubTimeZoneOutsideRequest();
  const plan = await deps.prisma.$transaction((tx) =>
    deps.planKeptLateCaptureXeroRecord({
      manualRefundTaskId: String(action.payload.manualRefundTaskId),
      bookingId: String(action.payload.bookingId),
      paymentIntentId: String(action.payload.paymentIntentId),
      clubZone,
      store: tx,
    }),
  );
  const queued =
    (plan.kind === "receipt-queued" || plan.kind === "kept-invoice-queued") && plan.queueOperationId ? plan : null;
  action.status = queued ? "queued" : "skipped";
  action.resultMessage = queued
    ? plan.kind === "receipt-queued"
      ? `The kept card payment's receipt is queued or sent (operation ${queued.queueOperationId}).`
      : `The kept card payment's Xero invoice is queued or sent (operation ${queued.queueOperationId}).`
    : plan.kind === "change-payment"
      ? "Nothing queued: a change invoice already answers this payment, and the late-success release owns it."
      : "Nothing queued: the payment is no longer kept, another Xero document records it, or no booking change can be read from it.";
}
