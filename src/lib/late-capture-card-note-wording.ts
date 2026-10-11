/**
 * #3924 round 14 (`INV-PAY-122`): WHAT AN OFFICER IS TOLD of a late capture's
 * card refunds that a card note sent to Xero without a reply may already
 * answer (`readUnnotedLateCaptureCardRefunds`, `mayBeInXeroCents`) - check
 * Xero for that credit note before recording them by hand, as a receipt that
 * may be in Xero is checked before it is retried.
 *
 * Pure: the one home of the sentence, read by the linked change invoice's
 * 409 and every record-by-hand finding of the repair tool (`INV-SSOT`).
 */
export function cardNoteMayBeInXeroSentence(amountLabel: string): string {
  return `A refund credit note for ${amountLabel} refunded to the card was sent to Xero but the app never heard back: check Xero for that credit note first, and record that ${amountLabel} by hand only if Xero does not hold it.`;
}
