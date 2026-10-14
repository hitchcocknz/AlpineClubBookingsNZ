# File-size allowances for #4104 — a card refund Stripe accepted and failed later is owed again

The rule - whose refund it is, which row owes it, the retry's generation and
the alert - lives in two new modules, `src/lib/card-refund-failed-later.ts`
and `src/lib/card-refund-status-sync.ts`. What each file below gains is the one
place it already owns being told about a refund that failed later.

file: src/lib/payment-transactions.ts
lines: 1617
reason: `recordStripeRefundLedgerEntry`'s guarded counted -> refused write is
  the only place a refund is seen to fail after it counted, so it is where that
  signal is spelled (`failedLater`, transition or replayed), and
  `recordStripeRefundsAgainstTransaction` is the transaction it must be kept
  owed in, under the Payment row lock it already holds - one call into the new
  module and the alert after its own commit. The review round added what only
  this file can do: `refundPaymentTransactions` reads a refund a moving row
  owns as refused and returns the decisions to a caller whose transaction it
  joined, the sync returns them too, and Stripe's cumulative figure floors the
  total only while counted rows back it. Moving any of it out would split the
  one writer of refund rows from the transition it alone can see.

file: src/lib/payment-recovery.ts
lines: 3450
reason: the payments cron's isolated read-back block gains the sibling call
  for ordinary card refunds beside the organiser children's (three lines and a
  comment), so one option still turns both on and a failure in either fails
  neither the other nor the run; and the stale-queue alert, which lives here,
  leaves out a row the runner will never claim (one spread line).

file: src/lib/stripe-webhook-service.ts
lines: 1849
reason: the event switch is the one dispatcher of Stripe events; three case
  labels and one call route `refund.failed` (and the two update events) to the
  new recorder, which holds all of the handling.

file: src/lib/booking-cancel.ts
lines: 2834
reason: the cancellation's inline catch is the only place its partial refund's
  answers are in hand, so it marks the slices made before the failure on its
  pre-persisted row (`markCancellationAttempt`, whose body lives in
  `refused-card-refund-retry.ts`): one call, one comment line.
