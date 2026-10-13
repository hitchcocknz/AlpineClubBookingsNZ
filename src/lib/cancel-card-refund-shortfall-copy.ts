/**
 * #4097 (`INV-PAY-129`): the officers' "Manual refund needed" wording for a
 * card cancellation whose card refund carried less than the refund due. Pure,
 * so the HTML template and the text body's `{{handBackNote}}`
 * (`manualRefundTaskAlertNote`) read the same sentences. Neither says what the
 * member was told: the alert's reason line does, because only the send knows
 * whether the member was emailed.
 */

/** The alert's first sentence: the HTML's warning box, and the note's lead. */
export const CARD_REFUND_SHORTFALL_ALERT_LEAD =
  "A booking paid by card has been cancelled, and its card refund could not carry all of the refund due - the rest has NOT been refunded.";

/** The alert's paragraph after its lead, shared by the HTML and the note. */
export const CARD_REFUND_SHORTFALL_ALERT_BODY =
  "The card refund covers only what the payment's records show can still go back to the card, which was less than the cancellation policy's refund; that usually means the payment's records disagree. The rest is on the payments board as up to two tasks. A part the payment's other (non-card) charges still hold is to be refunded by bank transfer: pay it, then mark it paid back, which also raises its Xero refund credit note. Any part beyond that is one the payment's records show already refunded, or that nothing holds: check Stripe and the bank before paying it, and dismiss it with a note if it was refunded. The reason line below gives each amount.";
