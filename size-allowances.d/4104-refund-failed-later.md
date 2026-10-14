# File-size allowances for #4104 — a card refund Stripe accepted and failed later is owed again

The rule - whose refund it is, which row owes it, the retry's generation and
the alert - lives in two new modules, `src/lib/card-refund-failed-later.ts`
and `src/lib/card-refund-status-sync.ts`. What each file below gains is the one
place it already owns being told about a refund that failed later.

file: src/lib/payment-transactions.ts
lines: 1592
reason: `recordStripeRefundLedgerEntry`'s guarded counted -> refused write is
  the only place a refund is seen to fail after it counted, so it is where that
  signal is spelled (`failedLater`), and `recordStripeRefundsAgainstTransaction`
  is the transaction it must be kept owed in, under the Payment row lock it
  already holds - two calls into the new module and the alert after its own
  commit. Moving either out would split the one writer of refund rows from the
  transition it alone can see.

file: src/lib/payment-recovery.ts
lines: 3447
reason: the payments cron's isolated read-back block gains the sibling call
  for ordinary card refunds beside the organiser children's (three lines and a
  comment), so one option still turns both on and a failure in either fails
  neither the other nor the run.

file: src/lib/stripe-webhook-service.ts
lines: 1849
reason: the event switch is the one dispatcher of Stripe events; three case
  labels and one call route `refund.failed` (and the two update events) to the
  new recorder, which holds all of the handling.
