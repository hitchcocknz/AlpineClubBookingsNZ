# File-size allowances for #4300

Each door that brings a succeeded card intent back now asks the webhook's own
superseded-intent check before it settles a booking (`INV-PAY-138`). The check
stays one function in the recovery module, beside the hand-off it runs; each
door gains only the call and its answer.

file: src/lib/payment-recovery.ts
lines: 3360
reason: the extended check needs the module's private hand-off
  (`handoffSucceededSupersededIntentToRefund`), so it cannot move out without
  exporting that writer; the growth is its docblock, one import and one line.

file: src/app/api/bookings/[id]/confirm-payment/route.ts
lines: 345
reason: the refusal has to sit in the route's classification window, between
  the refund-history check and the settle, so a failed check keeps the
  route's existing status-unconfirmed answer.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 899
reason: the check joins the existing refund-history discriminator in the
  succeeded-intent arm, so the repay mint it shares stays one path.
