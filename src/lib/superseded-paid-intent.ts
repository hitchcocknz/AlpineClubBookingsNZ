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
import logger from "@/lib/logger";

export async function isSupersededCaptureOfBooking(paymentIntentId: string, bookingId: string): Promise<boolean> {
  const paid = await getPaymentIntent(paymentIntentId).catch(() => null);
  if (!paid || paid.status !== "succeeded" || paid.metadata?.bookingId !== bookingId) return false;
  return queueSupersededPaymentIntentRefundRecovery(paid);
}

/**
 * #4300: after a saved-card door refused as `superseded_capture_returning`
 * (the claim transaction rolled back, so outside it), hand the capture to its
 * refund through the doors' own check - a dead cancel row would otherwise
 * leave it waiting for ever. Best-effort; never throws.
 */
export async function handOffSupersededCaptureAfterRefusal(refusal: { why: string; paymentIntentId: string | null; bookingId: string }): Promise<void> {
  if (refusal.why !== "superseded_capture_returning" || !refusal.paymentIntentId) return;
  try {
    const paid = await getPaymentIntent(refusal.paymentIntentId);
    if (paid.status === "succeeded") await queueSupersededPaymentIntentRefundRecovery(paid);
  } catch (err) {
    logger.error({ err, bookingId: refusal.bookingId, paymentIntentId: refusal.paymentIntentId }, "Could not hand a waiting superseded capture to its refund after a saved-card refusal; the next attempt asks again (#4300)");
  }
}
