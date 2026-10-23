- **A card payment on an out-of-date payment can no longer mark a booking paid
  and then be refunded (#4300).** When a booking was edited, the payment the
  member had already started was replaced and queued to be cancelled, or
  refunded if they paid it anyway. Only Stripe's own notification checked for
  that. If the member paid the old payment from a tab still open, and the
  booking's price had come back to its old amount, the payment page, a
  reloaded payment link, or Stripe's notification arriving after the refund was
  queued could mark the booking paid with it. The refund then went through,
  and the booking showed as paid with no money held.

  Every way a payment reaches the booking now makes the same check. That
  payment is refunded as before, the booking stays unpaid, and the member is
  told the payment is being refunded and asked to pay the amount the booking
  shows now. The payment page and the payment link offer a fresh payment.
