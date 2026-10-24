/**
 * #4211 (`INV-PAY-043`) - the words of the kept-capture alert
 * (`admin-duplicate-capture-kept`), shared by its hand-built HTML
 * (`email-templates/admin-duplicate-capture-kept.ts`), the
 * `{{duplicateCaptureKeptNote}}` token and the duplicate-capture guard's
 * reasons. A sibling of `email-message-notes.ts`, split by size, and like it
 * imports nothing.
 */

/**
 * Why the duplicate-capture guard kept a card capture instead of refunding it:
 * the booking is paid and another payment on it holds money, but the guard has
 * no usable record of which payment settled it.
 *
 * - `not-recorded`: `Payment.settledByTransactionId` is empty - paid before the
 *   record existed, by the previous app version during an upgrade, or by a bank
 *   receipt the settle could not match to exactly one receipt row.
 * - `settler-released`: the recorded settler no longer holds money (refunded,
 *   reversed, or going back to the member), so it says nothing about which
 *   remaining payment to keep - or, with nothing else holding money
 *   (`otherHoldsMoney: false`), whether this payment now pays for the booking.
 * - `new-capture` (#4285): no record and nothing else holds money, and the app
 *   had never recorded this payment before - new money on a booking that was
 *   paid some other way (account credit, a zero total, a group settlement) or
 *   whose earlier payment was refunded.
 *   Always `otherHoldsMoney: false`.
 * - `new-capture-closed` (#4285 review): that alert, still owed when the
 *   payments cron's drain sends it, on a booking cancelled or closed since. A
 *   cancellation refunds at most what the booking was worth, so part or all of
 *   a payment the booking never needed may still be held. The alert's amount is
 *   what the card payment still holds after card refunds taken from it; a
 *   refund the cancellation made as account credit or by hand never touches
 *   it, so the alert names that refund where the cancellation recorded one.
 * - `new-capture-later-payment` (#4285 review): that alert, still owed when the
 *   drain sends it, once another payment also holds money. Two payments now hold
 *   money on a booking paid another way or whose earlier payment was refunded.
 */
export type DuplicateCaptureKeptReason =
  | "not-recorded"
  | "settler-released"
  | "new-capture"
  | "new-capture-closed"
  | "new-capture-later-payment";

/**
 * #4285 review: what the cancellation's own record says it refunded, for a
 * `new-capture-closed` alert - its method and the amount, formatted by the
 * caller (this module imports nothing). `none`: no refund was due.
 */
export type CancellationRefundNote = { method: "card" | "credit" | "manual" | "none"; amount: string };

function cancellationRefundSentence(refund: CancellationRefundNote | null | undefined): string {
  if (!refund) return "";
  const said = {
    card: `it refunded ${refund.amount} to card`,
    credit: `it refunded ${refund.amount} as account credit`,
    manual: `${refund.amount} is to be paid back by hand`,
    none: "no refund was due",
  }[refund.method];
  return ` The cancellation's record shows ${said}.`;
}

/** The other payment, as the alert names it. */
function otherPaymentLabel(otherPaymentIntentId: string | null): string {
  return otherPaymentIntentId ? `card payment ${otherPaymentIntentId}` : "a cash or bank payment";
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The reason-specific paragraph, shared by the hand-built HTML and the
 * `{{duplicateCaptureKeptNote}}` token (#2268): the flat editable body has no
 * conditional syntax, so the sentence that differs travels as one token.
 */
export function duplicateCaptureKeptParagraph(input: {
  reason: DuplicateCaptureKeptReason;
  otherPaymentIntentId: string | null;
  /** False when nothing else holds money: a released settler and this payment alone (#4211 review). */
  otherHoldsMoney?: boolean;
  /** `new-capture-closed` only: the cancellation's recorded refund, when it recorded one. */
  cancellationRefund?: CancellationRefundNote | null;
}): string {
  const lead = input.otherHoldsMoney === false
    ? "A card payment arrived on this booking after it was already paid, and no other payment on it still holds money."
    : `A card payment arrived on this booking after it was already paid, and ${otherPaymentLabel(input.otherPaymentIntentId)} on it still holds money.`;
  switch (input.reason) {
    case "not-recorded":
      return `${lead} The app has no record of which payment settled this booking: it was paid before the app kept one, by the previous app version during an upgrade, or by a bank payment that could not be matched to a single receipt. So nothing was refunded automatically.`;
    case "settler-released":
      return input.otherHoldsMoney === false
        ? `${lead} The payment the app recorded as settling this booking no longer holds money (it was refunded or reversed, or is being refunded), so the app cannot tell whether this payment now pays for the booking or is a duplicate, and nothing was refunded automatically.`
        : `${lead} The payment the app recorded as settling this booking no longer holds money (it was refunded or reversed, or is being refunded), so the app cannot tell which of the remaining payments to keep, and nothing was refunded automatically.`;
    case "new-capture-closed":
      return `A new card payment was recorded on this booking after it was already paid, while no other card or bank payment on it held money, and the booking has since been cancelled or closed. A cancellation refunds at most what the booking was worth, so part or all of this payment may still be held: the amount shown is what this card payment still holds after any card refund taken from it. A refund made as account credit or by hand never touches it, so the booking may need less of it than it holds.${cancellationRefundSentence(input.cancellationRefund)}`;
    case "new-capture-later-payment":
      return `A new card payment was recorded on this booking after it was already paid, while no other card or bank payment on it held money: the booking was paid some other way (with account credit, at a zero total, or by a group organiser), or its earlier payment was refunded. ${capitalised(otherPaymentLabel(input.otherPaymentIntentId))} on it now also holds money, so one or both of them may be extra. Nothing was refunded automatically.`;
    case "new-capture":
      return "A new card payment was recorded on this booking after it was already paid, and no other card or bank payment on it holds money: the booking was paid some other way (with account credit, at a zero total, or by a group organiser), or its earlier payment was refunded, so this payment may be extra. Nothing was refunded automatically.";
  }
}

/**
 * What to do, shared by the hand-built HTML and the `{{duplicateCaptureKeptAction}}`
 * token (#4211 review): with another payment holding money one of the two is
 * extra; with none, this payment may be the only one left paying for the
 * booking, and refunding it would leave the booking unpaid. It ends with the
 * Stripe check the upgrade window needs - for two payments only: a `new-capture`
 * payment stands alone, so "neither payment" would be untrue (#4285 review).
 */
export function duplicateCaptureKeptAction(input: { otherHoldsMoney?: boolean; reason?: DuplicateCaptureKeptReason }): string {
  const action = input.otherHoldsMoney === false
    ? "Check whether this payment should pay for the booking; refund it by hand only if the booking should not be paid by it."
    : "Check which payment settled the booking, and refund the other one by hand.";
  if (input.reason === "new-capture-closed") {
    return "Check the cancellation's refund in the booking's history (it may have refunded part of the booking as account credit or by hand) and in Stripe how much of this payment is still held, then refund by hand what the booking no longer needs.";
  }
  if (input.reason === "new-capture-later-payment") {
    return "Check which of the two payments should pay for the booking, if either, and refund by hand any the booking does not need — both, if it was paid another way.";
  }
  return input.reason === "new-capture" ? action : `${action} ${DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK}`;
}

/** Fixed wording: the check the upgrade window needs (#4211 review). */
export const DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK =
  "Before you refund by hand, check in Stripe that neither payment has already been refunded: while an upgrade is switching over, the previous app version can still refund one automatically.";
