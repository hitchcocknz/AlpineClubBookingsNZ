/**
 * #4145 (`INV-SSOT`): THE REASON A MEMBER CANCEL'S CARD REFUND EVENT CARRIES,
 * and how the narrative finds that event again.
 *
 * The REFUNDED event is written by whichever close moves the cancel's card
 * refund row (`booking_cancel_refund_recovery_<booking>`) to `SUCCEEDED` - the
 * cancel's own close after its inline refund, or the recovery runner's after a
 * replay (`closeRefundRowRecordingEvent`). Both write this one sentence. The
 * runner rebuilds its figures from the cancel's CANCELLED snapshot, which froze
 * them with the decision.
 *
 * Pure: the booking narrative reads `isCancelCardRefundEvent`, and it must stay
 * importable without Prisma.
 */
import { BookingEventType } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

/** Every cancel card refund reason ends so, before #4145 and since. */
const CANCEL_CARD_REFUND_REASON_END = "refunded to the original payment method.";

/**
 * `refundPercentage` and `refundAmountCents` are the cancel's policy refund;
 * `cardRefundCents` what the card refund carries - less, on a card refund
 * shortfall (#4097), where the sentence says it is a part. With no policy
 * figures (a cancel whose CANCELLED snapshot is missing), it names the amount.
 */
export function cancelCardRefundEventReason({
  cardRefundCents,
  policy,
  shortfall,
  format,
}: {
  cardRefundCents: number;
  policy: { refundPercentage: number; refundAmountCents: number } | null;
  shortfall: boolean;
  format: ClubFormat;
}): string {
  if (!policy) return `${formatCents(cardRefundCents, format)} ${CANCEL_CARD_REFUND_REASON_END}`;
  return shortfall
    ? `${formatCents(cardRefundCents, format)} of the ${policy.refundPercentage}% refund (${formatCents(policy.refundAmountCents, format)}) ${CANCEL_CARD_REFUND_REASON_END}`
    : `${policy.refundPercentage}% ${CANCEL_CARD_REFUND_REASON_END}`;
}

/**
 * The member cancel's card refund event, told from the hand-back completions a
 * card refund shortfall also records as REFUNDED (`manual_refund_completed`).
 */
export function isCancelCardRefundEvent(event: { type: BookingEventType; reason: string | null }): boolean {
  return event.type === BookingEventType.REFUNDED && (event.reason?.endsWith(CANCEL_CARD_REFUND_REASON_END) ?? false);
}
