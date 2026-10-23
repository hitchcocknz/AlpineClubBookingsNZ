/**
 * #4300 (`INV-PAY-138`): after the settle REFUSED a capture the superseded
 * machinery owns (`markBookingPaymentSucceeded`'s `superseded_capture`), make
 * sure the machinery has it and tell the admins.
 *
 * Post-commit and best-effort; never throws, so the settle's answer always
 * reaches its door. The hand-off is the doors' own check
 * (`queueSupersededPaymentIntentRefundRecovery`): a live cancel row is handed to
 * its refund now rather than at the cancel worker's next run. The alert says
 * the booking was not settled and still owes, once a day per (booking,
 * capture) while repeats arrive (`claimAlertCooldownFailOpen`), because a
 * refusal here means a door's own check was overtaken (an edit inside its
 * unlocked window), a saved-card door met a superseded capture, or the capture
 * is partly owed back: each is worth a person looking.
 */
import { SETTLEMENT_MONEY_ALERT_REPEAT_MS, claimAlertCooldownFailOpen } from "@/lib/alert-cooldown-fail-open";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminPaymentFailureAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { queueSupersededPaymentIntentRefundRecovery } from "@/lib/payment-recovery";
import { formatCents } from "@/lib/utils";

export async function reportSupersededCaptureRefused({
  booking,
  memberName,
  paymentIntentId,
  amountCents,
  paymentMethodId,
  format,
}: {
  booking: { id: string; checkIn: Date; checkOut: Date };
  memberName: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
  format: ClubFormat;
}): Promise<void> {
  const context = { bookingId: booking.id, paymentIntentId, amountCents };
  logger.error(context, "A capture the superseded-intent machinery owns reached the settle; the booking was NOT settled with it (#4300)");
  try {
    await queueSupersededPaymentIntentRefundRecovery({ id: paymentIntentId, amount: amountCents, payment_method: paymentMethodId });
  } catch (err) {
    logger.error({ err, ...context }, "Could not hand a refused superseded capture to its refund now; the recovery cron's cancel row still does (#4300)");
  }
  const send = await claimAlertCooldownFailOpen({
    key: `superseded-capture-refused:${booking.id}:${paymentIntentId}`,
    windowMs: SETTLEMENT_MONEY_ALERT_REPEAT_MS,
    context,
    logMessage: "Could not claim the refused-superseded-capture alert's cooldown; alerting anyway (#4300)",
  });
  if (!send) return;
  await sendAdminPaymentFailureAlert({
    memberName,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    amountCents,
    errorMessage: `A card payment of ${formatCents(amountCents, format)} was taken on a payment that a later change to this booking had replaced. It did NOT mark the booking paid: the club's superseded-payment refund is returning it to the card, or holding it for a treasurer if the booking was cancelled. The booking still owes its payment. Check that the refund completes, and that the member pays the current amount.`,
    paymentIntentId,
  }, format).catch((err) =>
    logger.error({ err, ...context }, "Failed to alert admins about a refused superseded capture (#4300)"),
  );
}
