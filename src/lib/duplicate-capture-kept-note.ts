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
 *   remaining payment to keep.
 */
export type DuplicateCaptureKeptReason = "not-recorded" | "settler-released";

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
}): string {
  const lead = `A card payment arrived on this booking after it was already paid, and ${otherPaymentLabel(input.otherPaymentIntentId)} on it still holds money.`;
  switch (input.reason) {
    case "not-recorded":
      return `${lead} The app has no record of which payment settled this booking: it was paid before the app kept one, by the previous app version during an upgrade, or by a bank payment that could not be matched to a single receipt. So nothing was refunded automatically.`;
    case "settler-released":
      return `${lead} The payment the app recorded as settling this booking no longer holds money (it was refunded or reversed, or is being refunded), so the app cannot tell which of the remaining payments to keep, and nothing was refunded automatically.`;
  }
}

/** Fixed wording: what to do, and the check the upgrade window needs (#4211 review). */
export const DUPLICATE_CAPTURE_KEPT_ACTION =
  "Check which payment settled the booking, and refund the other one by hand.";
export const DUPLICATE_CAPTURE_KEPT_STRIPE_CHECK =
  "Before you refund by hand, check in Stripe that neither payment has already been refunded: while an upgrade is switching over, the previous app version can still refund one automatically.";
