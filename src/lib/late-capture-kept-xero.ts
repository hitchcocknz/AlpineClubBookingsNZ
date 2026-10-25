import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import type { ClubTimeZone } from "@/lib/club-time";
import { asRecord } from "@/lib/xero-json";
import {
  kickQueuedXeroOutboxOperationsIfConnected,
  lockSupplementaryInvoiceAnchor,
} from "@/lib/xero-operation-outbox";
import {
  RETIRED_CODES_ANSWERING_CAPTURE,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent,
} from "@/lib/xero-supplementary-invoice-late-capture";
import {
  enqueueXeroKeptLateCaptureInvoiceOperation,
  keptLateCaptureDocumentDate,
  lockKeptLateCaptureTask,
} from "@/lib/xero-kept-late-capture-invoice";
import { findLiveKeptReceiptRow } from "@/lib/kept-late-capture-receipt-rows";
import { creditBackLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { enqueueAdditionalCaptureReceiptOperation } from "@/lib/additional-capture-receipt-enqueue";
import { additionalCaptureReceiptKey } from "@/lib/additional-capture-xero-receipt";
import { captureChangeId } from "@/lib/additional-capture-receipt-link";
import { readCreditReleaseCaptureShare } from "@/lib/credit-release-capture-share";
import { recordedPrimaryInvoiceSettlement } from "@/lib/booking-primary-invoice-claim";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  decideLateCapture,
  bookingHasPrimaryXeroInvoice,
  keptChangeCaptureRoute,
  keptLateCaptureRecordRoute,
  type KeptChangeCaptureEvidence,
} from "@/lib/late-capture-kept-xero-rules";

/**
 * A LATE CAPTURE A TREASURER KEPT IS RECORDED IN XERO BY THE APP (#3635, owner
 * decision 29 Sep 2026, `INV-PAY-110`): "When a treasurer keeps a late card
 * capture on a cancelled booking, the app raises a Xero invoice for the kept
 * amount and marks it paid from the Stripe account, the same way a normal card
 * payment is recorded."
 *
 * Keeping is DISMISSING the #3639 approval task (`lateCaptureApprovalIntentId`).
 * The receipt is recorded GROSS, dated the capture day, and every refund of it
 * is answered by its own refund credit note (orchestrator decision 29 Sep
 * 2026). Which document records it:
 *
 * - The booking's OWN payment, and a change payment on a booking Xero never
 *   invoiced, get the kept-capture invoice (`xero-kept-late-capture-invoice.ts`),
 *   queued INSIDE the dismissal's claim so it commits with the decision.
 * - A CHANGE payment on a booking Xero invoiced is split on the evidence
 *   (#4324, owner decision 25 Oct 2026, `INV-PAY-141`;
 *   `keptChangeCaptureRoute`): a change invoice that already answers the
 *   capture is released after commit (or its retired row re-queued), then any
 *   refund already taken is credited back; where the primary invoice bills the
 *   change, the capture's own receipt (`INV-PAY-139`) records it as a payment
 *   on that invoice, capped at what Xero shows due; where nothing bills it,
 *   the kept-capture invoice; and where no change can be read, nothing.
 */

/** What the post-commit half of a keep must do. */
export type KeptLateCaptureXeroPlan =
  | { kind: "none" }
  | { kind: "change-payment"; paymentIntentId: string }
  | { kind: "kept-invoice-queued"; queueOperationId: string | null }
  | { kind: "receipt-queued"; queueOperationId: string };

/**
 * #4324: what the change a kept capture pays for shows in Xero
 * (`KeptChangeCaptureEvidence`). Read under the change's anchor lock by the
 * keep's decision, and without it by the repair tool's finding, which the
 * apply decides again under the lock.
 */
export async function readKeptChangeCaptureEvidence(
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink" | "bookingModification">,
  input: { paymentIntentId: string; changeId: string | null },
): Promise<KeptChangeCaptureEvidence> {
  const naming = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      requestPayload: { path: ["paymentIntentId"], equals: input.paymentIntentId },
    },
    select: { status: true, lastErrorCode: true },
  });
  const answers: readonly string[] = RETIRED_CODES_ANSWERING_CAPTURE;
  const answeredByChangeInvoice = naming.some(
    (row) => row.status !== "CANCELLED" || (row.lastErrorCode !== null && answers.includes(row.lastErrorCode)),
  );
  const { changeId } = input;
  if (changeId === null) {
    return { answeredByChangeInvoice, changeId, settledAgainstPrimary: false, changeInvoices: "none" };
  }
  const [change, rows, link] = await Promise.all([
    store.bookingModification.findUnique({ where: { id: changeId }, select: { newData: true } }),
    store.xeroSyncOperation.findMany({
      where: {
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        OR: [
          { localModel: "BookingModification", localId: changeId },
          { requestPayload: { path: ["bookingModificationId"], equals: changeId } },
        ],
      },
      select: { status: true, requestPayload: true },
    }),
    store.xeroObjectLink.findFirst({
      where: {
        localModel: "BookingModification",
        localId: changeId,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        active: true,
      },
      select: { id: true },
    }),
  ]);
  // The change's own invoices: never the #3980 gap invoice a marked edit anchors.
  const own = rows.filter((row) => asRecord(row.requestPayload)?.primaryInvoiceGap !== true);
  const changeInvoices: KeptChangeCaptureEvidence["changeInvoices"] =
    link !== null || own.some((row) => row.status !== "CANCELLED") ? "live" : own.length > 0 ? "withdrawn" : "none";
  return {
    answeredByChangeInvoice,
    changeId,
    settledAgainstPrimary: recordedPrimaryInvoiceSettlement(change?.newData) !== null,
    changeInvoices,
  };
}

/**
 * THE IN-TRANSACTION HALF of a keep, the one decision of which document
 * records a kept capture. Run by `resolveManualRefundTask` after its
 * status-fenced DISMISSED claim won, on the claim's own transaction (which
 * therefore holds the task row), and (#4324) by the repair tool on a
 * transaction of its own. A replayed dismissal loses that claim and never
 * reaches here; a keep after a reopen finds the task's live row and queues
 * nothing more. `clubZone` is read before the transaction (`INV-LOCK-004`).
 *
 * LOCKS (#4324, `INV-PAY-141`): the task row first (`lockKeptLateCaptureTask`;
 * the dismissal already holds it), the task re-read there and still
 * DISMISSED, then - for a change payment on an invoiced booking - the
 * per-anchor supplementary-invoice lock on the change (`captureChangeId`, else
 * the booking), the key its receipt and its supplementary invoice are queued
 * under. Under both the capture's existing record is found first (its receipt
 * row, its kept-capture invoice) and returned, never a second; then the
 * evidence is read and the route decided, once (`INV-PAY-139`). No new key, and
 * no provider call.
 */
export async function planKeptLateCaptureXeroRecord(params: {
  manualRefundTaskId: string;
  bookingId: string;
  paymentIntentId: string;
  actingMemberId?: string | null;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<KeptLateCaptureXeroPlan> {
  const { store } = params;
  await lockKeptLateCaptureTask(store, params.manualRefundTaskId);
  const [transaction, task] = await Promise.all([
    store.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: params.paymentIntentId },
      select: { kind: true, status: true, amountCents: true, paymentId: true, bookingModificationId: true, reason: true },
    }),
    store.manualRefundTask.findUnique({
      where: { id: params.manualRefundTaskId },
      select: { createdAt: true, status: true },
    }),
  ]);
  // A repair snapshot is stale once the task was reopened or refunded.
  if (task && task.status !== "DISMISSED") return { kind: "none" };
  const decision = decideLateCapture({
    taskStatus: "DISMISSED",
    bookingStatus: "CANCELLED",
    superseded: false,
    capture: transaction,
  });
  if (!transaction || !task || decision.recordCents === 0) return { kind: "none" };

  const payment = await store.payment.findUnique({
    where: { id: transaction.paymentId },
    select: { xeroInvoiceId: true },
  });
  const paymentLinks = await store.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: transaction.paymentId,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { role: true, xeroObjectType: true, active: true },
  });
  const queueKeptInvoice = async (capturedCents = decision.recordCents): Promise<KeptLateCaptureXeroPlan> => {
    const queued = await enqueueXeroKeptLateCaptureInvoiceOperation({
      manualRefundTaskId: params.manualRefundTaskId,
      bookingId: params.bookingId,
      paymentIntentId: params.paymentIntentId,
      capturedCents,
      capturedOn: keptLateCaptureDocumentDate(task.createdAt, params.clubZone),
      createdByMemberId: params.actingMemberId ?? null,
      store,
    });
    return { kind: "kept-invoice-queued", queueOperationId: queued.queueOperationId };
  };
  const firstCut = keptLateCaptureRecordRoute({
    captureKind: transaction.kind,
    bookingHasPrimaryInvoice: bookingHasPrimaryXeroInvoice({
      paymentXeroInvoiceId: payment?.xeroInvoiceId,
      paymentLinks,
    }),
  });
  if (firstCut === "kept-invoice") return queueKeptInvoice();

  // #4324: a change payment on an invoiced booking, decided under its anchor.
  const changeId = captureChangeId(transaction);
  await lockSupplementaryInvoiceAnchor(store, changeId ?? params.bookingId);
  if (await findLiveKeptReceiptRow(store, params.manualRefundTaskId)) return queueKeptInvoice();
  const receiptRow = await store.xeroSyncOperation.findFirst({
    where: { correlationKey: additionalCaptureReceiptKey(params.paymentIntentId), status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (receiptRow) return { kind: "receipt-queued", queueOperationId: receiptRow.id };
  const evidence = await readKeptChangeCaptureEvidence(store, { paymentIntentId: params.paymentIntentId, changeId });
  const route = keptChangeCaptureRoute(evidence);
  if (route === "change-invoice") return { kind: "change-payment", paymentIntentId: params.paymentIntentId };
  const logged = { paymentIntentId: params.paymentIntentId, manualRefundTaskId: params.manualRefundTaskId };
  if (route === "kept-invoice" || route === "change-unknown") {
    // The #4253 credit-release sweep records its share of the capture on the
    // primary, or holds the capture for an officer (`INV-ADDPAY-046`).
    const share = await readCreditReleaseCaptureShare(params.paymentIntentId, store);
    if (share.held || share.ownCents >= decision.recordCents) {
      logger.info({ ...logged, share }, "A kept late card payment is recorded, or held for an officer, by the credit-release sweep; nothing more was queued");
      return { kind: "none" };
    }
    if (route === "kept-invoice") return queueKeptInvoice(decision.recordCents - share.ownCents);
    logger.error(
      logged,
      "A kept late card payment names no booking change, so which Xero invoice bills it cannot be told; nothing was queued, and the booking-vs-Xero repair tool names it",
    );
    return { kind: "none" };
  }
  const receipt = await enqueueAdditionalCaptureReceiptOperation(params.paymentIntentId, {
    store,
    keptLateCapture: true,
    createdByMemberId: params.actingMemberId ?? null,
  });
  if (receipt.outcome === "not-eligible") {
    const context = { ...logged, reason: receipt.reason };
    const message = "A kept late card payment's receipt was not queued; another Xero document records it, or the repair tool names it";
    // No primary invoice id beside an active link is drift: nothing records it until the field is synced.
    if (receipt.reason === "no-primary-invoice") logger.error(context, message);
    else logger.warn(context, message);
    return { kind: "none" };
  }
  return { kind: "receipt-queued", queueOperationId: receipt.queueOperationId };
}

/**
 * THE POST-COMMIT HALF. Never throws: the decision has committed, and a Xero
 * outage must not turn a recorded keep into a failed request. Whatever this
 * misses the reaper (a waiting change invoice whose capture is kept), the
 * outbox (a queued kept invoice) or the repair tool picks up.
 */
export async function finishKeptLateCaptureXeroRecord(
  plan: KeptLateCaptureXeroPlan,
): Promise<void> {
  try {
    if (plan.kind === "change-payment") {
      const result = await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(
        plan.paymentIntentId,
      );
      // A dashboard refund taken before the keep found no receipt then.
      await creditBackLateCaptureRefunds(plan.paymentIntentId);
      if (result.queueOperationIds.length > 0) {
        await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
      }
      return;
    }
    if ((plan.kind === "kept-invoice-queued" || plan.kind === "receipt-queued") && plan.queueOperationId) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
  } catch (err) {
    logger.error(
      { err, plan },
      "Failed to finish recording a kept late capture in Xero; the reaper, the outbox or the repair tool picks it up",
    );
  }
}
