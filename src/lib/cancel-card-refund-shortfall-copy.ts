/**
 * #4097 (`INV-PAY-129`): the officers' "Manual refund needed" wording for a
 * card cancellation whose card refund carried less than the refund due. Pure,
 * so the HTML template and the text body's `{{handBackNote}}`
 * (`manualRefundTaskAlertNote`) read the same sentences.
 */

/** The alert's first sentence: the HTML's warning box, and the note's lead. */
export const CARD_REFUND_SHORTFALL_ALERT_LEAD =
  "A booking paid by card has been cancelled, and its card refund could not carry all of the refund due - the rest has NOT been refunded.";

/** The alert's paragraph after its lead, shared by the HTML and the note. */
export const CARD_REFUND_SHORTFALL_ALERT_BODY =
  "The card refund covers only what the payment's records show can still go back to the card, which was less than the cancellation policy's refund. That usually means the payment's records disagree. The system has raised a hand-back task for the difference, and the member has been told the club will refund it by bank transfer. Check the payment in Stripe: if the member has not had this money back, pay it by bank transfer, mark the task paid back, and record the refund in Xero by hand. If it was refunded another way, dismiss the task with a note saying how.";
