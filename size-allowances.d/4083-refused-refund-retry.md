# File-size allowances for #4083 — a card refund Stripe refuses stays owed and is retried under a fresh key

The rule and the runner's handling of a refusal live in a new module,
`src/lib/refused-card-refund-retry.ts`, and the key spelling in
`src/lib/payment-recovery-keys.ts`, so none of the three files below gains the
rule. What each gains is the one place it already owns being told about a
refusal. Comments were cut to one line each and the runner's call compacted
first.

file: src/lib/payment-transactions.ts
lines: 1604
reason: `refundPaymentTransactions` is the only code that sends each slice and
  reads Stripe's answer, so it is where a slice's key generation is spelled
  into the request, where each refund is returned with the slice as sent, and
  where a refused slice is kept out of `completedRefundCents` and named on
  `PartialRefundError`. Moving the loop out would split the one sender of
  refund slices across two modules.

file: src/lib/payment-recovery.ts
lines: 3429
reason: the runner's refund call is wrapped in `refundPlanOrRetryRefusals`
  (one import, three lines of call), and `enqueueBookingModificationRefundRecovery`
  passes an optional frozen plan through to the existing ledger enqueue (three
  lines). Both are the existing functions every caller already uses.

file: src/lib/booking-cancel.ts
lines: 2823
reason: the cancel's inline refund must not close its pre-persisted debt when
  Stripe refused a slice. Two lines route that case into the existing catch,
  which already leaves the debt open and records why, plus one import and a
  three-line comment naming the rule.
