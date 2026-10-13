/**
 * #4117 (`INV-PAY-128`): what the refund-requests screen says about an approved
 * appeal's card refund, from the part still owed by card - not yet made, queued
 * for the recovery runner's retry (`cardRefundOwedCents`). Plain module: the
 * client page imports it.
 */

/** The toast after an approval: "processed" only when the card refund was made in full. */
export function refundAppealApprovedNotice(
  cardRefundOwedCents: number,
  cardRefundQueued: boolean,
  formatAmount: (cents: number) => string,
): string {
  if (cardRefundOwedCents <= 0) return "Refund approved and processed"
  return cardRefundQueued
    ? `Refund approved; ${formatAmount(cardRefundOwedCents)} is queued for retry`
    : `Refund approved; ${formatAmount(cardRefundOwedCents)} could not be queued for retry - the officers have been alerted to refund it another way`
}

/** What an approved appeal has refunded so far: the approved amount less what the card still owes. */
export function refundAppealRefundedCents(approvedAmountCents: number, cardRefundOwedCents: number): number {
  return Math.max(0, approvedAmountCents - Math.max(0, cardRefundOwedCents))
}
