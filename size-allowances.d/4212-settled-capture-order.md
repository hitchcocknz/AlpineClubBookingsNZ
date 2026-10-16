# File-size allowances for #4177 — the duplicate-capture refund's settled capture is read in the ledger order

file: src/lib/payment-reconciliation.ts
lines: 3156
reason: the duplicate-capture guard's candidate read gains its `orderBy` and
  the shared order's import, plus a two-line comment naming which capture
  counts as the settlement and why. The read sits inside
  `settleBookingPaymentInTransaction`'s lock(1) transaction beside the guards
  (b′), (c) and (c′) it feeds; lifting it out is a refactor of that function,
  not this fix.
