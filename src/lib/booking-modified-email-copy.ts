/**
 * THE MEMBER-FACING REFUND SENTENCES OF A BOOKING'S EMAILS (`INV-SSOT`).
 *
 * Named for "Booking Modified", where it started (#3827), but the ONE home for
 * the refund sentence of the "Booking Modified", "Booking Cancelled" and
 * "Refund Appeal Approved" emails - HTML template and admin-editable body alike -
 * and for the cancel dialog's on-screen confirmation of an organiser-paid
 * refund (#3973). Pure, with no imports, so a client component can read it.
 * Every function takes the settlement's own answer of where the money went or
 * is going; nothing here decides it.
 */

/**
 * #3916, #3973: a refund on a joiner's booking the group organiser paid for by
 * card goes back to the ORGANISER's card (#3653), not to anything the joiner
 * paid with. ONE wording for the "Booking Modified" and "Booking Cancelled"
 * emails, HTML and admin-editable body alike, and the cancel dialog's
 * confirmation. The caller passes the settlement's own answer that the refund
 * went there.
 */
export function organiserCardRefundSentence(amount: string): string {
  return `A refund of ${amount} has been processed to the group organiser's card, because the group organiser paid for this booking.`;
}

/**
 * #3973: that refund to the organiser's card, not yet made - Stripe has not
 * answered it, and the recovery runner retries it until it does. A joiner's own
 * cancel whose refund did not complete inline, or the organiser's cancel of the
 * group whose refund for this child did not.
 */
export function organiserCardRefundPendingSentence(amount: string): string {
  return `A refund of ${amount} is on its way to the group organiser's card, because the group organiser paid for this booking.`;
}

/**
 * #3653, #3973: a joiner cancelling behind the group organiser's cancellation,
 * which already carries this booking's refund to the organiser's card as its
 * own debt. `refunded` is that debt's own status (`SUCCEEDED`). The cancel, its
 * preview (`groupCancellationRefundNote`) and its email say it in these words.
 */
export function groupCancellationRefundSentence(amount: string, refunded: boolean): string {
  return refunded
    ? `The group organiser's cancellation refunded ${amount} for this booking to the organiser's card.`
    : `The group organiser's cancellation is already refunding ${amount} for this booking to the organiser's card.`;
}

/**
 * #3956 (`INV-PAY-123`): what the group ORGANISER is told when a joiner's
 * approved refund appeal is refunded to the organiser's card. ONE wording for
 * the HTML template and the admin-editable body's `{{refundSentence}}`.
 * "Is being refunded" holds whether Stripe has answered yet or not.
 */
export function organiserJoinerAppealRefundSentence(amount: string, joinerName: string): string {
  return `The club has approved a refund appeal from ${joinerName}, who is in your group booking. Because you paid for their place, ${amount} for their share is being refunded to the card you paid with.`;
}

/**
 * #3973: an organiser cancel of a group the organiser settled by Internet
 * Banking. There is no card to refund, so the club repays the organiser by
 * hand; it is promised, not reported, and never to the joiner.
 */
export function organiserByHandRefundSentence(amount: string): string {
  return `The club will refund ${amount} to the group organiser directly, because the group organiser paid for this booking.`;
}

/**
 * #3973: a refund on a joiner's booking the group organiser paid for by card,
 * which goes to the ORGANISER's card (#3653): made (`organiser_card`), still on
 * its way (`organiser_card_pending`), or carried by the organiser's earlier
 * cancellation of the group, still running (`group_cancel_refunding`) or made
 * (`group_cancel_refunded`). The cancel's result carries one, so the
 * confirmation screen says what the email says.
 */
export type OrganiserRefundMethod =
  | "organiser_card"
  | "organiser_card_pending"
  | "group_cancel_refunding"
  | "group_cancel_refunded";

/** #3956: an approved appeal's refund to the organiser's card - made, or on its way. */
export type OrganiserCardAppealRefund = Extract<OrganiserRefundMethod, "organiser_card" | "organiser_card_pending">;

/**
 * Where a "Booking Cancelled" email says the refund went. B5 (#2262): "manual"
 * is a cash / off-Xero settlement a person hands back, so it must never read as
 * "on its way to your card" (no card was charged) nor as account credit (none
 * was minted; a hand-back task was raised). #3973: the organiser's card
 * refunds (`OrganiserRefundMethod`), and "organiser_by_hand", an organiser's
 * Internet Banking settlement the club repays by hand.
 */
export type BookingCancelledRefundMethod = "card" | "credit" | "manual" | "organiser_by_hand" | OrganiserRefundMethod;

/**
 * #3973: the refund line of a "Booking Cancelled" email, ONE wording for the
 * HTML template, the admin-editable body's `{{refundMessage}}` and the cancel
 * dialog's organiser-paid confirmation (`INV-SSOT`). `amount` is `refundCents`
 * formatted in the club's format.
 */
export function bookingCancelledRefundSentence(
  refundCents: number,
  amount: string,
  refundMethod: BookingCancelledRefundMethod,
): string {
  if (refundCents <= 0) return "No refund was applicable based on the cancellation policy.";
  switch (refundMethod) {
    case "manual":
      return `You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of ${amount} directly and will be in touch.`;
    case "organiser_card":
      return organiserCardRefundSentence(amount);
    case "organiser_card_pending":
      return organiserCardRefundPendingSentence(amount);
    case "group_cancel_refunding":
      return groupCancellationRefundSentence(amount, false);
    case "group_cancel_refunded":
      return groupCancellationRefundSentence(amount, true);
    case "organiser_by_hand":
      return organiserByHandRefundSentence(amount);
    case "credit":
      return `A credit of ${amount} has been added to your account for future bookings.`;
    case "card":
      return ownCardRefundSentence(amount);
  }
}

/**
 * #3973: a refund already made reads as a success; a hand-back, a refund still
 * on its way, or no refund at all reads as information. The email's box and the
 * confirmation screen both ask here.
 */
export function bookingCancelledRefundMade(refundCents: number, refundMethod: BookingCancelledRefundMethod): boolean {
  if (refundCents <= 0) return false;
  return refundMethod === "card" || refundMethod === "credit" || refundMethod === "organiser_card" || refundMethod === "group_cancel_refunded";
}

/** A card refund back to what the member paid with; Booking Modified and Booking Cancelled alike. */
function ownCardRefundSentence(amount: string): string {
  return `A refund of ${amount} has been processed to your original payment method.`;
}

/**
 * #4057: where a "Booking Modified" refund went, as the edit's settlement
 * answers it after commit (`executeBookingModificationRefund`), never
 * recomputed. `own`: back to what the member paid with - their card, or by bank
 * transfer when the club sends it by hand. `organiser_card`: a joiner's booking
 * the group organiser paid for by card (#3653), and the refund's debt says
 * Stripe made it. `organiser_card_pending`: that refund, not made yet - failed,
 * not claimed in the run, or unreadable - and owed to the recovery runner.
 */
export type BookingModifiedRefundDestination =
  | "own"
  | Extract<OrganiserRefundMethod, "organiser_card" | "organiser_card_pending">;

/**
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): the refund half of a
 * "Booking Modified" email's money note, ONE wording for the HTML template and
 * the admin-editable body (`INV-SSOT`). A card refund has already been made by
 * the time the email goes; a bank-transfer refund is an officer task the club
 * has still to carry out, so it is promised rather than reported. #3916,
 * #4057: an organiser-card refund is reported made only when its debt says so,
 * otherwise it is on its way; such a refund is a Stripe one, so never by hand.
 */
export function bookingModifiedRefundSentence(
  amount: string,
  refundByBankTransfer: boolean,
  refundDestination: BookingModifiedRefundDestination,
): string {
  switch (refundDestination) {
    case "organiser_card":
      return organiserCardRefundSentence(amount);
    case "organiser_card_pending":
      return organiserCardRefundPendingSentence(amount);
    case "own":
      return refundByBankTransfer
        ? `The club will refund ${amount} to you by bank transfer.`
        : ownCardRefundSentence(amount);
  }
}

/**
 * #4057: an organiser-card refund still on its way reads as information, the
 * way "Booking Cancelled" boxes it (`bookingCancelledRefundMade`); every other
 * edit refund keeps its success box.
 */
export function bookingModifiedRefundPending(refundDestination: BookingModifiedRefundDestination): boolean {
  return refundDestination === "organiser_card_pending";
}

/**
 * #3827 (owner decision D-3813-7, `INV-PAY-118`): the refund sentence of a
 * "Refund Appeal Approved" email, ONE wording for the HTML template and the
 * admin-editable body's `{{refundSentence}}` (`INV-SSOT`). The part a card
 * refund carries is on its way; the part the club sends by bank transfer is an
 * officer task still to be done, so it is promised, the same way as an edit's.
 * `bankTransferCents` is the part of `approvedCents` the club sends by hand
 * (0 when the card carries it all).
 */
export function refundRequestApprovedRefundSentence(
  approvedCents: number,
  bankTransferCents: number,
  formatAmount: (cents: number) => string,
  /**
   * #3956 (`INV-PAY-123`): the booking was paid for by the group organiser's
   * card, so the whole refund goes there - made (`organiser_card`, its debt
   * says so), or still on its way (`organiser_card_pending`). Null for any
   * other booking.
   */
  organiserCardRefund: OrganiserCardAppealRefund | null = null,
): string {
  if (organiserCardRefund === "organiser_card") return organiserCardRefundSentence(formatAmount(approvedCents));
  if (organiserCardRefund === "organiser_card_pending") {
    return organiserCardRefundPendingSentence(formatAmount(approvedCents));
  }
  const cardCents = approvedCents - bankTransferCents;
  if (bankTransferCents <= 0) {
    return `A refund of ${formatAmount(approvedCents)} will be processed to your original payment method.`;
  }
  if (cardCents <= 0) {
    return `The club will refund ${formatAmount(bankTransferCents)} to you by bank transfer.`;
  }
  return `A refund of ${formatAmount(cardCents)} will be processed to your original payment method, and the club will refund the remaining ${formatAmount(bankTransferCents)} to you by bank transfer.`;
}
