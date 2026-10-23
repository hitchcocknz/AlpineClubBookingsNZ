/**
 * #3953 (`INV-PAY-138`): QUEUE THE RECEIPT of a booking change's card capture
 * that no supplementary invoice was waiting on, once per capture. Called by
 * the late-success release (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`)
 * when it answers `none-queued`, from each caller that has seen the capture -
 * the Stripe webhook, the confirm route, a treasurer's keep - and by the
 * booking-vs-Xero repair tool for a capture already missed.
 *
 * EXACTLY ONCE. The find-and-create runs under the per-anchor
 * supplementary-invoice lock (`lockSupplementaryInvoiceAnchor`) - keyed on the
 * change the capture pays for (`PaymentTransaction.bookingModificationId`), or
 * the booking where the ledger row names none: the anchors that lock already
 * serialises, so no new key. Under it a row for this capture in any status but
 * CANCELLED is found and returned, never a second queued beside it; the
 * webhook racing the confirm route, or a replay, serialise and the later
 * caller finds the first's row.
 *
 * What it records, and when it refuses, is the worker's
 * (`additional-capture-xero-receipt.ts`): this only checks the capture is a
 * captured card payment for a change on a booking whose primary invoice is
 * linked.
 */
import { prisma } from "@/lib/prisma";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { startXeroSyncOperation } from "@/lib/xero-sync";
import { lockSupplementaryInvoiceAnchor } from "@/lib/xero-operation-outbox";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { additionalCaptureReceiptKey } from "@/lib/additional-capture-xero-receipt";

export type AdditionalCaptureReceiptEnqueueResult =
  | { outcome: "queued"; queueOperationId: string }
  | { outcome: "already-queued"; queueOperationId: string }
  | { outcome: "not-eligible"; reason: "no-capture" | "not-a-change-card-capture" | "no-primary-invoice" };

/** The outbox row shape, shared with the repair tool's read of it. */
export const ADDITIONAL_CAPTURE_RECEIPT_OPERATION = {
  direction: "OUTBOUND",
  entityType: "PAYMENT",
  operationType: "CREATE",
  localModel: "PaymentTransaction",
  queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
} as const;

export async function enqueueAdditionalCaptureReceiptOperation(
  paymentIntentId: string,
  options?: { createdByMemberId?: string | null },
): Promise<AdditionalCaptureReceiptEnqueueResult> {
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: {
      id: true,
      kind: true,
      source: true,
      status: true,
      bookingModificationId: true,
      payment: { select: { id: true, bookingId: true, xeroInvoiceId: true } },
    },
  });
  if (!transaction) return { outcome: "not-eligible", reason: "no-capture" };
  if (
    transaction.kind !== "ADDITIONAL" ||
    transaction.source !== "STRIPE" ||
    !isCapturedTransactionStatus(transaction.status)
  ) {
    return { outcome: "not-eligible", reason: "not-a-change-card-capture" };
  }
  if (!transaction.payment.xeroInvoiceId) return { outcome: "not-eligible", reason: "no-primary-invoice" };

  const { payment } = transaction;
  const key = additionalCaptureReceiptKey(paymentIntentId);
  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, transaction.bookingModificationId ?? payment.bookingId);
    const existing = await tx.xeroSyncOperation.findFirst({
      where: { correlationKey: key, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) return { outcome: "already-queued" as const, queueOperationId: existing.id };
    const operation = await startXeroSyncOperation({
      ...ADDITIONAL_CAPTURE_RECEIPT_OPERATION,
      localId: transaction.id,
      status: "PENDING",
      idempotencyKey: key,
      correlationKey: key,
      requestPayload: {
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        bookingId: payment.bookingId,
        paymentId: payment.id,
        paymentTransactionId: transaction.id,
        paymentIntentId,
      },
      createdByMemberId: options?.createdByMemberId ?? null,
      store: tx,
    });
    return { outcome: "queued" as const, queueOperationId: operation.id };
  });
}
