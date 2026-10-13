/**
 * The narrative for a booking cancelled AFTER it was paid: what was paid, and
 * what the cancellation policy did with it — refunded, added to account credit,
 * being handed back by the club, or retained.
 *
 * Moved out of `booking-narrative.ts` (#3991), which is at its size budget;
 * `buildCancelledNarrative` there is the one caller and decides when this
 * applies (a paid event exists) and which settlement event is the
 * cancellation's own. Pure, like that module: the club's bound time arrives as
 * data.
 *
 * `ownerCreditHidden` (#3991): the viewer cannot see the booking owner's account
 * credit (`canSeeOwnerCredit` on the booking page), so a cancellation settled
 * as CREDIT drops its "added to your account credit" figure and says only what
 * was retained. The figures it keeps (what was paid, what was retained) still
 * let the remainder be worked out by subtraction; it withholds the statement,
 * not the arithmetic.
 */
import { BookingEventType } from "@prisma/client";
import type { BoundClubTime } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import type { CancellationEventSnapshot } from "@/lib/booking-events";
import type { BookingNarrative, NarrativeEvent } from "@/lib/booking-narrative";
import { formatCents } from "@/lib/utils";

function asCancellationSnapshot(
  value: unknown
): CancellationEventSnapshot | null {
  if (value && typeof value === "object") {
    return value as CancellationEventSnapshot;
  }
  return null;
}

export function buildCancelledPostPaymentNarrative(
  paidEvent: NarrativeEvent,
  cancelEvent: NarrativeEvent | undefined,
  settlementEvent: NarrativeEvent | undefined,
  club: BoundClubTime, format: ClubFormat,
  ownerCreditHidden: boolean,
): BookingNarrative {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  const paidAmountCents = paidEvent.amountCents ?? snapshot?.paidAmountCents ?? 0;
  const settledAmountCents =
    settlementEvent?.amountCents ?? snapshot?.settledAmountCents ?? 0;
  const retainedAmountCents =
    snapshot?.retainedAmountCents ??
    Math.max(paidAmountCents - settledAmountCents, 0);

  const paidOn = club.instantDate(paidEvent.occurredAt);
  const cancelOn = cancelEvent
    ? club.instantDate(cancelEvent.occurredAt)
    : paidOn;
  const opening = `You cancelled this booking on ${cancelOn} after paying ${formatCents(paidAmountCents, format)} on ${paidOn}.`;

  let settlementClause: string;
  if (
    settledAmountCents > 0 &&
    settlementEvent?.type === BookingEventType.CREDITED &&
    ownerCreditHidden
  ) {
    // #3991: the credit is the owner's; say only what the club kept.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(retainedAmountCents, format)} was retained`
        : "nothing was retained";
  } else if (settledAmountCents > 0 && settlementEvent) {
    const settledOn = club.instantDate(settlementEvent.occurredAt);
    const verb =
      settlementEvent.type === BookingEventType.CREDITED
        ? "added to your account credit"
        : "refunded";
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents, format)} was ${verb} on ${settledOn} and ${formatCents(retainedAmountCents, format)} was retained`
        : `${formatCents(settledAmountCents, format)} was ${verb} on ${settledOn}`;
  } else if (snapshot?.refundMethod === "manual" && settledAmountCents > 0) {
    // B5 (#2262): a cash / off-Xero settlement is handed back by a person, so
    // there is no settlement event YET — one is written when the club marks the
    // hand-back complete. Saying "no refund was due" here would be a lie about
    // the member's money.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents, format)} is being refunded to you by the club directly (you paid in cash or by bank transfer, so there is no card payment to reverse) and ${formatCents(retainedAmountCents, format)} was retained`
        : `${formatCents(settledAmountCents, format)} is being refunded to you by the club directly — you paid in cash or by bank transfer, so there is no card payment to reverse`;
  } else {
    settlementClause = `no refund was due and the full ${formatCents(retainedAmountCents, format)} was retained`;
  }

  return {
    state: "cancelled_post_payment",
    headline: "Booking cancelled",
    message: `${opening} Under the cancellation policy in effect at the time, ${settlementClause}. No further payment is required.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}
