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
 *   send it again. The officers are alerted for the whole unmade amount, split
 *   into what Stripe refused (refund it another way) and what got no answer
 *   (it may have been made: check Stripe first), and the route records it on
 *   the request and its audit row.
 * - When no row can be written and Stripe was never asked, nothing moved: the
 *   route releases the claim for a manual retry, as before #1039. Nothing was
 *   refused, so nothing was alerted, and a second approval alerts once.
 */
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { enqueueRefundRequestRefundRecovery } from "@/lib/payment-recovery";
import { prisma } from "@/lib/prisma";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { formatCents } from "@/lib/utils";
import { cardRefundNotQueuedMessage } from "@/lib/refund-request-card-refund-copy";
import {
  alertRefusedCardRefund,
  firstRefusals,
  type InlineRefundRead,
  refusedRefundCents,
} from "@/lib/refused-card-refund-retry";

/** What became of the unmade part: nothing owed, queued, not queued (approval stands), or release the claim. */
export type RefundRequestCardRefundOutcome = "nothing_owed" | "queued" | "not_queued" | "release_claim";

/** What the approve route answers, and audits, about its card refund (#4117). */
export interface RefundRequestCardRefundAnswer {
  /** Not made: queued for retry, or - `cardRefundQueued` false - for an officer. */
  cardRefundOwedCents: number;
  cardRefundQueued: boolean;
  /** Of that, refused by Stripe: certainly not made. */
  cardRefundRefusedCents: number;
  /** Of that, with no answer from Stripe: it may have been made. */
  cardRefundUnansweredCents: number;
}

export const NO_CARD_REFUND_OWED: RefundRequestCardRefundAnswer = {
  cardRefundOwedCents: 0,
  cardRefundQueued: true,
  cardRefundRefusedCents: 0,
  cardRefundUnansweredCents: 0,
};

export function refundRequestCardRefundAnswer(read: InlineRefundRead, outcome: RefundRequestCardRefundOutcome): RefundRequestCardRefundAnswer {
  return {
    cardRefundOwedCents: read.unmadeCents,
    cardRefundQueued: outcome !== "not_queued",
    cardRefundRefusedCents: read.refusedCents,
    cardRefundUnansweredCents: read.unansweredCents,
  };
}

export async function queueUnmadeRefundRequestCardRefund({
  bookingId,
  paymentId,
  refundRequestId,
  read,
  paymentIntentIdFallback,
  adminNotes,
  format,
}: {
  bookingId: string;
  paymentId: string;
  refundRequestId: string;
  read: InlineRefundRead;
  /** The officer's notes on the approval: a refund not queued is stamped after them. */
  adminNotes: string | null | undefined;
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
          // Split (#4117): a refused part is refunded another way; an unanswered
          // one may have been made, so Stripe is checked first.
          errorMessage: cardRefundNotQueuedMessage(read, (cents) => formatCents(cents, format)),
        },
        format,
      );
    } catch (alertErr) {
      logger.error({ err: alertErr, refundRequestId }, "Could not alert the officers to a card refund that could not be queued (#4117)");
    }
    // On the request itself too, where the screen shows it: best effort, as the
    // database may be what failed (the approval's audit row also records it).
    const note = cardRefundNotQueuedMessage(read, (cents) => formatCents(cents, format));
    await prisma.refundRequest
      .updateMany({ where: { id: refundRequestId, status: "APPROVED" }, data: { adminNotes: adminNotes ? `${adminNotes}\n\n${note}` : note } })
      .catch((stampErr: unknown) => logger.error({ err: stampErr, refundRequestId }, "Could not note an unqueued card refund on its request (#4117)"));
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
