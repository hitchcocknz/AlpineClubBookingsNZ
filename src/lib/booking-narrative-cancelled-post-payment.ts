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
import type { CardRefundState, CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { cardRefundOnItsWay } from "@/lib/booking-modified-email-copy";

/** #4125: what the club follows up - a dead card refund, a part no refund covers - as the clause's ending (`INV-SSOT`). */
function clubWillBeInTouch(subjects: string[]): string {
  return subjects.length > 0 ? `; the club will be in touch about ${subjects.join(" and ")}` : "";
}
const STALLED_CARD_REFUND = "the card refund";

/** #4097, #4125: one card refund, by where it stands - the shortfall's card part and a whole card refund alike (`INV-SSOT`). */
function cardRefundClause(amount: string, state: CardRefundState, refundedOn: string | null): string {
  switch (state) {
    case "on-its-way":
      return cardRefundOnItsWay(amount);
    case "paid-another-way":
      return `${amount} could not go back to your card and was paid back to you another way`;
    case "stalled":
      return `${amount} is being refunded to you`;
    case "settled":
      return `${amount} was refunded to your card${refundedOn ? ` on ${refundedOn}` : ""}`;
  }
}

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
    clauses.push(cardRefundClause(money(parts.cardCents), statuses.card ?? "settled", cardRefundedOn));
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
  const joined = clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : (clauses[0] ?? "no refund was due");
  // #4125: a dead card part is the club's to follow up.
  return `${joined}${clubWillBeInTouch(parts.cardCents > 0 && statuses.card === "stalled" ? [STALLED_CARD_REFUND] : [])}`;
}

/**
 * #4125: the capacity race's payment, as the paid fact the narrative opens
 * with. That settle cancels instead of recording MEMBER_PAID, so without this
 * the page would say no payment had been taken. The CANCELLED snapshot froze
 * what was paid, and the payment completed as the booking was cancelled.
 */
export function capacityRacePaidEvent(cancelEvent: NarrativeEvent | undefined): NarrativeEvent | undefined {
  const snapshot = asCancellationSnapshot(cancelEvent?.snapshot);
  if (!cancelEvent || snapshot?.cancelledBecause !== "capacity_race" || !(snapshot.paidAmountCents > 0)) return undefined;
  return { type: BookingEventType.MEMBER_PAID, occurredAt: cancelEvent.occurredAt, amountCents: snapshot.paidAmountCents, reason: null, snapshot: null };
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
  cardRefundState?: CardRefundState,
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
  // #4125: a capacity-race cancel was the system's, not the member's.
  const capacityRace = snapshot?.cancelledBecause === "capacity_race";
  const opening =
    capacityRace
      ? `This booking was cancelled on ${cancelOn}, after you paid ${formatCents(paidAmountCents, format)} on ${paidOn}, because the dates filled up while your payment was going through.`
      : `You cancelled this booking on ${cancelOn} after paying ${formatCents(paidAmountCents, format)} on ${paidOn}.`;

  let settlementClause: string;
  const followUps: string[] = [];
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
    // #4125: a card refund with no REFUNDED event was not made inline - it
    // threw, or Stripe refused it - so it says where its recovery row stands:
    // still being sent (the default when the caller read none), dead, made by
    // the runner on a row closed before it recorded REFUNDED, or paid another
    // way. Never "no refund was due", and never "refunded" before it is.
    //
    // Only the member's own card: a joiner's booking the organiser paid for
    // by card (`paidByOrganiserCard`) is refunded to the ORGANISER's card, and
    // never reaches here - its settle writes MEMBER_PAID with no amount
    // (`group-settlement.ts`), so the paid-amount gate above
    // (`buildCancelledNarrative`'s `paidEvent`) sends it to the pre-payment
    // narrative. `booking-narrative.test.ts` pins that.
    const state = cardRefundState ?? "on-its-way";
    const refund = cardRefundClause(formatCents(settledAmountCents, format), state, null);
    const retained = retainedAmountCents > 0 ? ` and ${formatCents(retainedAmountCents, format)} was retained` : "";
    settlementClause = `${refund}${retained}`;
    if (state === "stalled") followUps.push(STALLED_CARD_REFUND);
  } else {
    settlementClause = `no refund was due and the full ${formatCents(retainedAmountCents, format)} was retained`;
  }
  // #4125: a capacity race refunds what the payment ledger showed refundable,
  // which can be less than the charge; the snapshot keeps nothing back, so the
  // rest is neither refunded nor retained - say so, never "no further payment".
  const unaccountedCents = capacityRace ? paidAmountCents - settledAmountCents - retainedAmountCents : 0;
  if (unaccountedCents > 0) followUps.push(`the remaining ${formatCents(unaccountedCents, format)}`);
  settlementClause += clubWillBeInTouch(followUps);

  return {
    state: "cancelled_post_payment",
    headline: "Booking cancelled",
    // #4125: no policy decided a capacity-race refund - the whole charge goes back.
    message: `${opening} ${capacityRace ? settlementClause.charAt(0).toUpperCase() + settlementClause.slice(1) : `Under the cancellation policy in effect at the time, ${settlementClause}`}. No further payment is required.`,
    nextStep:
      "If you'd like to stay another time, you can book again from the bookings page whenever you're ready.",
  };
}
