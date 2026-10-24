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
 *   a payment the booking never needed may still be held; the alert's amount is
 *   what it still holds.
 * - `new-capture-later-payment` (#4285 review): that alert, still owed when the
 *   drain sends it, after another payment holding money was recorded on the
 *   booking since. Two payments now hold money on a booking paid another way.
 */
export type DuplicateCaptureKeptReason =
  | "not-recorded"
  | "settler-released"
  | "new-capture"
  | "new-capture-closed"
  | "new-capture-later-payment";

/** The other payment, as the alert names it. */
function otherPaymentLabel(otherPaymentIntentId: string | null): string {
  return otherPaymentIntentId ? `card payment ${otherPaymentIntentId}` : "a cash or bank payment";
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
      return "A new card payment was recorded on this booking after it was already paid, while no other card or bank payment on it held money, and the booking has since been cancelled or closed. A cancellation refunds at most what the booking was worth, so part or all of this payment may still be held: the amount shown is what it still holds after any refund the cancellation made.";
    case "new-capture-later-payment":
      return `A new card payment was recorded on this booking after it was already paid some other way (with account credit, at a zero total, or by a group organiser), and ${otherPaymentLabel(input.otherPaymentIntentId)} recorded on it since also holds money, so one of them is probably extra. Nothing was refunded automatically.`;
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
    return "Check in Stripe how much of this payment is still held, and refund by hand what the booking no longer needs.";
  }
  if (input.reason === "new-capture-later-payment") {
    return "Check which of the two payments should pay for the booking, if either, and refund the other by hand.";
  }
  return input.reason === "new-capture" ? action : `${action} ${DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK}`;
}

/** Fixed wording: the check the upgrade window needs (#4211 review). */
export const DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK =
  "Before you refund by hand, check in Stripe that neither payment has already been refunded: while an upgrade is switching over, the previous app version can still refund one automatically.";
