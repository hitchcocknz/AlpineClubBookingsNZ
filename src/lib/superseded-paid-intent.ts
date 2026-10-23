/**
 * #4300 (`INV-PAY-138`): an intent the payer has just paid that the booking's
 * pointer has moved past (a fresh intent was minted meanwhile). Is it this
 * booking's own capture, and the superseded machinery's - going back to the
 * card? Asked by `confirm-payment` before its "does not match" 400, and by the
 * `/pay` link after a card success, so both say the payment is being returned.
 *
 * Only an intent Stripe reports `succeeded` whose metadata names this booking
 * is looked into: another booking's intent, or one that never captured, is
 * nobody's business here. The answer is the doors' own check
 * (`queueSupersededPaymentIntentRefundRecovery`), which hands a capture a live
 * cancel row names to its refund.
 */
import { queueSupersededPaymentIntentRefundRecovery } from "@/lib/payment-recovery";
import { getPaymentIntent } from "@/lib/stripe";

export async function isSupersededCaptureOfBooking(paymentIntentId: string, bookingId: string): Promise<boolean> {
  const paid = await getPaymentIntent(paymentIntentId).catch(() => null);
  if (!paid || paid.status !== "succeeded" || paid.metadata?.bookingId !== bookingId) return false;
  return queueSupersededPaymentIntentRefundRecovery(paid);
}
