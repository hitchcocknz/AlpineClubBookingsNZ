/**
 * #4102, #4117 (`INV-PAY-128`): AN APPROVED REFUND REQUEST'S CARD REFUND, AFTER
 * ITS INLINE ATTEMPT - what is still owed is queued for the recovery runner,
 * and the officers hear what they must.
 *
 * The route sends the frozen plan inline and reads the attempt
 * (`inlineRefundAfterAttempt`): refused slices on their next key, made ones
 * marked, unanswered ones on their own key. Whatever is still unmade is queued
 * as one row, keyed by the request, whose plan is the whole read plan and whose
 * amount is the plan's total, as the cancellation's and the runner's are.
 *
 * - The officers are alerted for the slices refused here when this approval
 *   wrote the row (`firstRefusals`, `alertRefusedCardRefund`).
 * - When no row can be written and Stripe was asked (anything but a throw
 *   before the first Stripe call), the approval STANDS: releasing it would let
 *   a second approval plan the refund afresh over the money already made, and
 *   send it again. The officers are alerted for the whole unmade amount, the
 *   only record of it, and the route says it was not queued.
 * - When no row can be written and Stripe was never asked, nothing moved: the
 *   route releases the claim for a manual retry, as before #1039. Nothing was
 *   refused, so nothing was alerted, and a second approval alerts once.
 */
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { enqueueRefundRequestRefundRecovery } from "@/lib/payment-recovery";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import {
  alertRefusedCardRefund,
  cardRefundNotQueuedMessage,
  firstRefusals,
  type InlineRefundRead,
  refusedRefundCents,
} from "@/lib/refused-card-refund-retry";

/** What became of the unmade part: nothing owed, queued, not queued (approval stands), or release the claim. */
export type RefundRequestCardRefundOutcome = "nothing_owed" | "queued" | "not_queued" | "release_claim";

export async function queueUnmadeRefundRequestCardRefund({
  bookingId,
  paymentId,
  refundRequestId,
  read,
  paymentIntentIdFallback,
  format,
}: {
  bookingId: string;
  paymentId: string;
  refundRequestId: string;
  read: InlineRefundRead;
  /** The payment's own intent, for an alert with no refused answer to name one. */
  paymentIntentIdFallback: string;
  format: ClubFormat;
}): Promise<RefundRequestCardRefundOutcome> {
  if (read.unmadeCents <= 0) return "nothing_owed";
  const refusedCents = refusedRefundCents(read.refused.map((answer) => answer.slice));
  if (refusedCents > 0) {
    logger.error({ refundRequestId, refusedCents }, "Stripe refused part of an approved appeal's card refund - enqueueing durable recovery");
  }
  let created: boolean;
  try {
    ({ created } = await enqueueRefundRequestRefundRecovery({
      bookingId,
      paymentId,
      refundRequestId,
      amountCents: read.plan.reduce((sum, slice) => sum + slice.amountCents, 0),
      allocationPlan: read.plan,
    }));
  } catch (enqueueErr) {
    if (!read.reachedStripe) {
      logger.error({ err: enqueueErr, refundRequestId }, "Failed to enqueue refund recovery - releasing the claim for manual retry");
      return "release_claim";
    }
    logger.error({ err: enqueueErr, refundRequestId }, "Failed to enqueue refund recovery after Stripe was asked - the approval stands, the officers are alerted");
    try {
      await alertPaymentRecoveryOfficers(
        {
          bookingId,
          amountCents: read.unmadeCents,
          paymentIntentId: read.refused[0]?.paymentIntentId || paymentIntentIdFallback,
          errorMessage: cardRefundNotQueuedMessage(read.unmadeCents, format),
        },
        format,
      );
    } catch (alertErr) {
      logger.error({ err: alertErr, refundRequestId }, "Could not alert the officers to a card refund that could not be queued (#4117)");
    }
    return "not_queued";
  }
  const first = firstRefusals(read.refused);
  if (created && first.length > 0) {
    await alertRefusedCardRefund(
      {
        bookingId,
        paymentIntentId: first[0]?.paymentIntentId || paymentIntentIdFallback,
        refusedCents: refusedRefundCents(first.map((answer) => answer.slice)),
      },
      format,
    );
  }
  return "queued";
}
