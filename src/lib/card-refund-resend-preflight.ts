/** Stripe evidence before a charge-backed recovery sends again (INV-PAY-145). */
import type { PaymentRecoveryOperation, PaymentTransaction } from "@prisma/client";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { recordStripeRefundsAgainstTransaction, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import logger from "@/lib/logger";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { queueRecordedCardRefundNotes } from "@/lib/recorded-card-refund-notes";
import { cardRefundDoorOf } from "@/lib/card-refund-own-note-share";
import { stripeReferenceId } from "@/lib/stripe-references";

export class UnattributedCardRefundBeforeResendError extends Error {
  constructor(readonly stripeRefundIds: string[]) {
    super("A refund made outside the app may already have paid this debt (INV-PAY-145). The app sent nothing and stopped automatic retries. Check the Stripe refunds and the booking before paying anything else. If money is still owed, use Paid another way in Stuck States; do not make a new Stripe dashboard refund. If nothing is owed, ask a developer to reconcile the row.");
  }
}

/**
 * The slice's captured charge, read straight from its ledger row. The row
 * stores no Stripe charge id: an intent has at most one succeeded charge, and
 * only a succeeded charge can be refunded, so the intent names the charge.
 */
type Charge = Pick<PaymentTransaction, "id" | "stripePaymentIntentId">;

/**
 * No caller transaction: the provider read finishes before the canonical writer
 * opens its own Payment-row-locked transaction. All slices are checked before
 * any is sent, including on a row's first runner attempt after an inline call.
 */
export async function checkCardRefundResend({
  operation,
  plan,
  transactions,
}: {
  operation: Pick<PaymentRecoveryOperation, "paymentId" | "bookingId" | "createdAt">;
  plan: readonly RefundAllocationSlice[];
  transactions: readonly Charge[];
}): Promise<void> {
  const unmadeIds = new Set(plan.filter((slice) => !slice.madeRefundId).map((slice) => slice.paymentTransactionId));
  const charges = transactions.filter((row) => unmadeIds.has(row.id));
  if (charges.length !== unmadeIds.size) throw new Error("Refund preflight could not find every planned charge (INV-PAY-145)");
  for (const charge of charges) {
    if (!charge.stripePaymentIntentId) throw new Error("Refund preflight charge has no Stripe intent (INV-PAY-145)");
    const refunds = await listRefundsForPaymentIntent(charge.stripePaymentIntentId, { timeoutMs: 10_000, singlePage: true });
    // The list is by intent already; a refund naming another intent is not this charge's.
    const onCharge = refunds.filter((refund) =>
      !refund.payment_intent || stripeReferenceId(refund.payment_intent) === charge.stripePaymentIntentId,
    );
    if (onCharge.length === 0) continue;
    // The writer deduplicates unseen refunds and refreshes known statuses. Its
    // refusal result prevents a stale Stripe listing reviving a known failure.
    const recorded = await recordStripeRefundsAgainstTransaction({
      paymentId: operation.paymentId,
      paymentTransactionId: charge.id,
      refunds: onCharge,
      fallbackPaymentIntentId: charge.stripePaymentIntentId,
    });
    if (!recorded.payment) throw new Error("Refund preflight could not reconcile the payment (INV-PAY-145)");
    await queueRecordedCardRefundNotes({
      payment: recorded.payment,
      paymentIntentId: charge.stripePaymentIntentId,
      deltaCents: Math.max(recorded.appliedCents, 0),
      refunds: onCharge,
      newlyCountedRefundIds: recorded.newlyCountedRefundIds,
    }).catch((error: unknown) => {
      // Recording committed already. As in charge.refunded, note failure must
      // not hide the dashboard hold or cause another money movement.
      logger.error({ err: error, paymentId: operation.paymentId }, "Failed to queue preflight refund credit note");
      void notifyXeroSyncError({
        errorType: "CREDIT_NOTE_CREATION",
        operation: `Queue refund credit note for payment ${operation.paymentId}`,
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    });
    const unexpected: string[] = [];
    for (const refund of onCharge) {
      if (isRecordedRefundStatus(refund.status ?? "unknown") &&
        !recorded.readAsRefused.includes(refund.id) &&
        cardRefundDoorOf(refund.metadata) === "outside-app" &&
        refund.created >= Math.floor(operation.createdAt.getTime() / 1000)) {
        unexpected.push(refund.id);
      }
    }
    // Conclusive evidence must hold the row even if another charge's read
    // would fail. No further provider reads are needed to refuse every slice.
    if (unexpected.length > 0) throw new UnattributedCardRefundBeforeResendError(unexpected);
  }
}
