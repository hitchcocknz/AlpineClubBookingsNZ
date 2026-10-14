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
import type { CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #4097 (`INV-PAY-129`): a card cancel whose card refund plan carried less than
 * the refund due. Frozen on the CANCELLED event (`cardShortfall`): the card's
 * part and the two parts beside it. Each of those is a task whose status the
 * page reads live, so the sentence follows it: still owed, refunded by bank
 * transfer, or checked and closed by the club.
 */
function cardShortfallClause(
  parts: { cardCents: number; bankCents: number; checkCents: number },
  statuses: CardShortfallTaskStatuses,
  { cardRefundedOn, retainedAmountCents, format }: { cardRefundedOn: string | null; retainedAmountCents: number; format: ClubFormat },
): string {
  const money = (cents: number) => formatCents(cents, format);
  const clauses: string[] = [];
  if (parts.cardCents > 0) {
    // The card part as its own refund stands, as the cancellation email says it.
    clauses.push(
      statuses.card === "on-its-way"
        ? `${money(parts.cardCents)} is on its way to your card`
        : statuses.card === "paid-another-way"
          ? `${money(parts.cardCents)} could not go back to your card and was paid back to you another way`
          : `${money(parts.cardCents)} was refunded to your card${cardRefundedOn ? ` on ${cardRefundedOn}` : ""}`,
    );
  }
  if (parts.bankCents > 0) {
    const status = statuses.bank ?? "OPEN";
    clauses.push(
      status === "COMPLETED"
        ? `${money(parts.bankCents)} was refunded to you by bank transfer`
        : status === "DISMISSED"
          ? `the club has recorded the ${money(parts.bankCents)} as settled`
          : `${money(parts.bankCents)} is being refunded to you by bank transfer`,
    );
  }
  if (parts.checkCents > 0) {
    const status = statuses.check ?? "OPEN";
    // Nothing went to the card or by bank: it is the whole refund, not "the remaining" one.
    const remaining = parts.cardCents > 0 || parts.bankCents > 0 ? "remaining " : "";
    clauses.push(
      status === "COMPLETED"
        ? `${money(parts.checkCents)} was refunded to you by bank transfer`
        : status === "DISMISSED"
          ? `the club checked the ${remaining}${money(parts.checkCents)} and closed it`
          : `the club will be in touch about the ${remaining}${money(parts.checkCents)}${remaining ? "" : " refund"}`,
    );
  }
  if (retainedAmountCents > 0) clauses.push(`${money(retainedAmountCents)} was retained`);
  return clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : (clauses[0] ?? "no refund was due");
}

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
  cardShortfallStatuses: CardShortfallTaskStatuses = {},
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
  if (snapshot?.cardShortfall) {
    settlementClause = cardShortfallClause(snapshot.cardShortfall, cardShortfallStatuses, {
      cardRefundedOn: settlementEvent ? club.instantDate(settlementEvent.occurredAt) : null,
      retainedAmountCents,
      format,
    });
  } else if (
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
  } else if (snapshot?.refundMethod === "card" && settledAmountCents > 0) {
    // #4125: a card refund with no REFUNDED event yet was not made inline - it
    // threw, or Stripe refused it - and its recovery row is retrying it. Saying
    // "no refund was due" would deny the member's money; "refunded" would claim
    // money not yet back.
    settlementClause =
      retainedAmountCents > 0
        ? `${formatCents(settledAmountCents, format)} is on its way back to your original payment method and ${formatCents(retainedAmountCents, format)} was retained`
        : `${formatCents(settledAmountCents, format)} is on its way back to your original payment method`;
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
