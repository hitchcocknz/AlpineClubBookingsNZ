// Issue #818: a Stripe refund moves money immediately, but the matching Xero
// refund credit note is created best-effort after the fact. Once an invoiced,
// refunded payment has gone this long without xeroRefundCreditNoteId being set,
// the accounting follow-up has almost certainly failed/been dropped rather than
// still being in flight, so it should be surfaced as a local↔Xero divergence.
// #4162: a voided bank-transfer refund note waits the same window before the
// treasurer's list shows it (`bank-refund-void-report.ts`). A pure leaf, so
// both reports read it without importing each other.
export const REFUND_CREDIT_NOTE_GRACE_HOURS = 24;
