# File-size allowances for PR #4213 (#4162) — a voided bank-transfer refund note, recorded again or confirmed

The list, both writers and the record-again note's sizing live in new modules
(`bank-refund-void-report.ts`, `bank-refund-void-resolution.ts`,
`bank-refund-re-record-note.ts`, `bank-refund-void-copy.ts`). What each file
below gains is the one place it already owns being told about a record-again.

file: src/lib/payment-transactions.ts
lines: 1707
reason: `unwindLocalRefundAllocation` is the inverse of
  `applyLocalRefundAllocation` and has to share its private compare-and-set
  (`compareAndSetRefundedAmount`), its backfill and the Payment-row-first lock
  order (#3640) that only this module holds; moving it out would export the
  compare-and-set or copy it.

file: src/lib/xero-credit-notes.ts
lines: 1419
reason: the refund-note executor sizes and keys a record-again's note from its
  record, beside the paid-another-way close's branch it mirrors, in the one
  function that mints refund notes (`createXeroCreditNote`); the sizing itself
  is `readReRecordShare`, in its own module.

file: src/lib/xero-operation-outbox.ts
lines: 3365
reason: the refund-note enqueue takes the `reRecordId` option beside
  `paidAnotherWayTaskId` (one sizing branch, one key part, the shared
  own-record row filter) and the dispatcher passes it through; the one enqueue
  every refund note goes through is where the option belongs.

file: src/lib/xero-operation-retry.ts
lines: 2027
reason: an operator retry of a record-again's note must carry `reRecordId`, or
  it would be re-sized from the payment-wide gap (two lines beside the close's).

file: src/lib/stuck-state-dashboard.ts
lines: 1162
reason: one more Xero signal in the one aggregator of stuck-state items, the
  same shape as the card refund signal beside it.

file: src/lib/xero-hardening-report.ts
lines: 1168
reason: the nightly digest adds one informational section; the section's
  builder lives in `bank-refund-void-report.ts`, so this file gains only the
  call and the spread.
