# File-size allowances for #4103 — no other card refund door closes, or says "refunded", on a refusal

The rule lives in `src/lib/refused-card-refund-retry.ts` (one helper for every
door whose recovery row predates its attempt, `keepRefusedPrePersistedRefundOwed`),
the late-capture hold in `src/lib/late-capture-refund-hold.ts`, and the edit
review's card refund moved whole into `src/lib/edit-financial-review-card-refund.ts`.
What each file below gains is the one call its own refund makes to that rule,
in the function that already owns the refund. Comments were cut to one or two
lines first.

file: src/lib/payment-reconciliation.ts
lines: 3176
reason: the duplicate-capture and capacity-race refunds each gain a one-line
  closure over the shared re-plan, a refusal check after the attempt, a re-plan
  in the catch for a slice refused before a throw, and a guard so the door's
  existing failure alert is the refusal's only alert. Both refunds live inside
  `markBookingPaymentSucceeded`'s post-commit tail; lifting either out is a
  refactor of that function, not this fix.

file: src/lib/payment-recovery.ts
lines: 3469
reason: the superseded-payment refund processor routes its one Stripe call
  through `refundPlanOrRetryRefusals`, keeping its legacy first key and sending
  a moved slice through `refundPaymentTransactions` after a refusal. The call
  and its callback belong in the processor that owns the row.

file: src/lib/group-cancel.ts
lines: 969
reason: the legacy group settlement refund, inline and in the replay, fails on
  a refusal as on a throw: one line each, a one- or two-line comment, and two
  imports.

file: src/lib/stripe-webhook-service.ts
lines: 1848
reason: each late-capture handler gains one line handing a refused refund to
  the hold (`holdLateCaptureRefusedByStripe`), the superseded group intent's
  refund one refusal line with a two-line comment, and two imports.

file: src/lib/booking-cancel.ts
lines: 2836
reason: the cancellation's call moves to the generalised helper, which needs
  the row's key spelled out (four lines where there were three, and one import).
