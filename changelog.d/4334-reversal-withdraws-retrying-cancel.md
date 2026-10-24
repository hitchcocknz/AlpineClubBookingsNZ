- **Reversing a payment recorded outside the app no longer leaves a stuck card
  cancellation that refunds the member's next card payment (#4320).** When an
  officer records a booking as paid outside the app (cash or bank transfer),
  the app cancels any card payment the member still had open. If Stripe was
  unreachable at that moment, the cancellation waited to retry. Reversing the
  payment used to leave that waiting cancellation behind. If the member then
  paid by card in the page they still had open, the payment was refunded and
  the booking stayed unpaid.

  The reversal now works out again, from the booking as it stands, which open
  card payments are out of date. It keeps cancelling those, including one an
  edit had already queued, and withdraws the cancellation of the one the
  booking can still be paid with, even one waiting to retry or one that has
  given up. A card payment the member makes while the reversal is running now
  waits for it, then pays the booking. The reversal's audit entry lists every
  cancellation it withdrew and every card payment still being cancelled.
  Reversals made before this release may have left a cancellation behind:
  `docs/UPGRADING.md` has a read-only query to find them and what to do.
