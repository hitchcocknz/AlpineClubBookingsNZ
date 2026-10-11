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
 * #3653, #3973: the group organiser's cancellation owes this joiner's booking a
 * refund to the organiser's card that has not completed yet (the recovery
 * runner retries it). The joiner's own cancel behind the group's, its preview
 * (`groupCancellationRefundNote`) and the "Booking Cancelled" email of either
 * cancel say it in these words.
 */
export function groupCancellationRefundSentence(amount: string): string {
  return `The group organiser's cancellation is already refunding ${amount} for this booking to the organiser's card.`;
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
 * Where a "Booking Cancelled" email says the refund went. B5 (#2262): "manual"
 * is a cash / off-Xero settlement a person hands back, so it must never read as
 * "on its way to your card" (no card was charged) nor as account credit (none
 * was minted; a hand-back task was raised). #3973: "organiser_card" is a
 * joiner's booking the group organiser paid for by card, refunded to the
 * organiser's card (#3653) - by the joiner's own cancel or the organiser's
 * cancel of the group. "organiser_card_owed" is that refund still owed (the
 * Stripe refund has not completed; the recovery runner retries it), and
 * "organiser_by_hand" an organiser's Internet Banking settlement the club
 * repays by hand.
 */
export type BookingCancelledRefundMethod =
  | "card"
  | "credit"
  | "manual"
  | "organiser_card"
  | "organiser_card_owed"
  | "organiser_by_hand";

/**
 * #3973: the refund line of a "Booking Cancelled" email, ONE wording for the
 * HTML template and the admin-editable body's `{{refundMessage}}` (`INV-SSOT`).
 * `amount` is `refundCents` formatted in the club's format.
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
    case "organiser_card_owed":
      return groupCancellationRefundSentence(amount);
    case "organiser_by_hand":
      return organiserByHandRefundSentence(amount);
    case "credit":
      return `A credit of ${amount} has been added to your account for future bookings.`;
    case "card":
      return ownCardRefundSentence(amount);
  }
}

/** A card refund back to what the member paid with; Booking Modified and Booking Cancelled alike. */
function ownCardRefundSentence(amount: string): string {
  return `A refund of ${amount} has been processed to your original payment method.`;
}

/**
 * #3827 (owner decision D-3813-6, `INV-PAY-117`): the refund half of a
 * "Booking Modified" email's money note, ONE wording for the HTML template and
 * the admin-editable body (`INV-SSOT`). A card refund has already been made by
 * the time the email goes; a bank-transfer refund is an officer task the club
 * has still to carry out, so it is promised rather than reported.
 */
export function bookingModifiedRefundSentence(
  amount: string,
  refundByBankTransfer: boolean,
  /**
   * #3916: a joiner's booking the group organiser paid for by card refunds its
   * reduction to the ORGANISER's card (#3653), not to anything the joiner paid
   * with. The edit's own settlement answer (`organiserChildRefund !== null`),
   * never recomputed here. Such a refund is a Stripe one, so never by hand.
   */
  refundReturnedToOrganiser: boolean,
): string {
  if (refundReturnedToOrganiser) return organiserCardRefundSentence(amount);
  return refundByBankTransfer
    ? `The club will refund ${amount} to you by bank transfer.`
    : ownCardRefundSentence(amount);
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
): string {
  const cardCents = approvedCents - bankTransferCents;
  if (bankTransferCents <= 0) {
    return `A refund of ${formatAmount(approvedCents)} will be processed to your original payment method.`;
  }
  if (cardCents <= 0) {
    return `The club will refund ${formatAmount(bankTransferCents)} to you by bank transfer.`;
  }
  return `A refund of ${formatAmount(cardCents)} will be processed to your original payment method, and the club will refund the remaining ${formatAmount(bankTransferCents)} to you by bank transfer.`;
}
