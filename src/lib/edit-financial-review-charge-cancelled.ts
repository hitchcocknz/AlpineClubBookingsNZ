import "server-only";

import type { ClubFormat } from "@/lib/club-format";
import {
  findEditReviewChargeRequest,
  recordUncollectedEditReviewChargeShare,
  sumEditReviewChargeSharesCents,
} from "@/lib/edit-financial-review-charge-request";
import { isCapturedTransactionStatus } from "@/lib/payment-transactions";

/**
 * #4272: the durable, officer-findable trace of a review charge whose booking was
 * cancelled before its share was asked for.
 *
 * The completion's chooser refuses a cancelled booking before the claim, so this
 * is the RACE behind it: a cancellation that commits after the completion but
 * before the sync asks the card. The sync then asks nothing and leaves the debt
 * on the recovery row, and the replay's cancelled-booking skip calls this before
 * it closes that row. Without it the task reads COMPLETED and the money it
 * settled leaves no trace but a log line.
 *
 * What the member already paid towards this edit - a captured request from an
 * earlier share - is counted as collected, so a paid request covering every
 * settled share writes nothing. Anything else on the edit's request was retired
 * by the cancellation and collected nothing.
 */
export async function recordCancelledEditReviewChargeShare({
  bookingId,
  paymentId,
  bookingModificationId,
  memberId,
  format,
}: {
  bookingId: string;
  paymentId: string;
  bookingModificationId: string;
  memberId: string | null;
  format: ClubFormat;
}): Promise<void> {
  const derivedTotalCents = await sumEditReviewChargeSharesCents({ bookingId, bookingModificationId });
  if (derivedTotalCents <= 0) return;
  const request = await findEditReviewChargeRequest({ paymentId, bookingModificationId });
  const paid = request && isCapturedTransactionStatus(request.status) ? request : null;
  const paidForThisEditCents = paid ? paid.amountCents - paid.carriedAskCents : 0;
  if (paidForThisEditCents >= derivedTotalCents) return;
  await recordUncollectedEditReviewChargeShare({
    format,
    leg: "payment-request",
    cause: "booking-cancelled",
    // The card leg's remedy is collecting by hand, never a second Xero invoice.
    secondAsk: null,
    bookingId,
    bookingModificationId,
    memberId,
    derivedTotalCents,
    requestedTotalCents: paid?.amountCents ?? 0,
    carriedAskCents: paid?.carriedAskCents ?? 0,
  });
}
