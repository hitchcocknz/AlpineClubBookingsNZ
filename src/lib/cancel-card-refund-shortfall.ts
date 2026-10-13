import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { sendAdminManualRefundTaskAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { cancelCardShortfallOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { formatCents } from "@/lib/utils";

/**
 * #4097 (`INV-PAY-129`): AN OWN-CARD CANCEL'S REFUND THAT ITS CARD REFUND PLAN
 * CANNOT CARRY IS OWED BY HAND.
 *
 * The paid cancel freezes its card refund plan in its claim
 * (`planStripeRefundAllocation`), from what the payment's captured Stripe
 * charges can still refund. The policy's refund comes from the payment record,
 * so when the two disagree the plan carries less - sometimes nothing - and
 * before this the rest was only logged: nothing owed it, and the member was
 * told the whole amount had been refunded.
 *
 * Now the remainder is a `CANCELLED_BOOKING_HAND_BACK` - the task a cash
 * cancel raises (#2262), so it is counted in "Refunds owed" and off Net
 * Collected while OPEN (`openHandBackOwedCents`), sits in the money-to-settle
 * queue, and completes as a hand-back by bank transfer - written in the claim
 * transaction, under the claim's locks, beside the plan's recovery row. One per
 * booking (`cancelCardShortfallOccurrenceKey`), inserted `ON CONFLICT DO
 * NOTHING` (`skipDuplicates`) so a replay can never abort the claim; the claim's
 * status flip is already single-flight. Its amount is fixed at creation
 * (`raisedAmountCents` mirrors it), as every cancellation hand-back's is.
 */
export async function raiseCancelCardShortfallHandBack(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    paymentId: string;
    /** The policy's refund to the card. */
    refundAmountCents: number;
    /** What the frozen card refund plan carries. */
    plannedCardRefundCents: number;
    format: ClubFormat;
  },
): Promise<{ taskId: string; shortfallCents: number } | null> {
  const { bookingId, paymentId, refundAmountCents, plannedCardRefundCents, format } = params;
  const shortfallCents = refundAmountCents - Math.max(0, plannedCardRefundCents);
  if (shortfallCents <= 0) return null;
  const occurrenceKey = cancelCardShortfallOccurrenceKey(bookingId);
  await tx.manualRefundTask.createMany({
    data: [
      {
        bookingId,
        paymentId,
        amountCents: shortfallCents,
        raisedAmountCents: shortfallCents,
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        occurrenceKey,
        reason: `Booking ${bookingId} cancelled - its card refund could carry only ${formatCents(Math.max(0, plannedCardRefundCents), format)} of the ${formatCents(refundAmountCents, format)} refund due, so the club refunds the remaining ${formatCents(shortfallCents, format)} by bank transfer. Dismiss with a note if it was refunded another way (#4097).`.slice(
          0,
          MANUAL_REFUND_TASK_REASON_MAX,
        ),
      },
    ],
    skipDuplicates: true,
  });
  const task = await tx.manualRefundTask.findUnique({
    where: { occurrenceKey },
    select: { id: true, amountCents: true },
  });
  if (!task) throw new Error(`The card refund shortfall task for booking ${bookingId} was not written (#4097).`);
  logger.warn(
    { bookingId, paymentId, refundAmountCents, plannedCardRefundCents, manualRefundTaskId: task.id },
    "Cancellation card refund plan covers less than the refund due; the remainder is owed by hand on a hand-back task (#4097)",
  );
  return { taskId: task.id, shortfallCents: task.amountCents ?? shortfallCents };
}

/**
 * #4097: tell the officers, once, after the cancel commits. Admin audience, so
 * exempt from the per-booking "No emails" switch (#2258 rule 2), as the cash
 * cancel's alert is. Never throws: the task is the durable record.
 */
export function alertCancelCardShortfall(
  data: {
    memberName: string;
    checkIn: Date;
    checkOut: Date;
    bookingId: string;
    shortfallCents: number;
    manualRefundTaskId: string;
    reason: string;
  },
  format: ClubFormat,
): void {
  sendAdminManualRefundTaskAlert(
    {
      memberName: data.memberName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      refundAmountCents: data.shortfallCents,
      bookingId: data.bookingId,
      reason: data.reason,
      situation: "card-refund-shortfall",
    },
    format,
  ).catch((err) =>
    logger.error(
      { err, bookingId: data.bookingId, manualRefundTaskId: data.manualRefundTaskId },
      "Failed to alert admins about a card refund shortfall's hand-back task",
    ),
  );
}
