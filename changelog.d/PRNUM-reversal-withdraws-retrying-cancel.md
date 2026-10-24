- **Reversing a cash payment no longer leaves a stuck card cancellation that
  refunds the member's next card payment (#4320).** When an officer records a
  booking as paid in cash, the app cancels any card payment the member still
  had open. If Stripe was unreachable at that moment, the cancellation waited
  to retry. Reversing the cash payment used to leave that waiting cancellation
  behind. If the member then paid by card in the page they still had open, the
  payment was refunded and the booking stayed unpaid.

  The reversal now withdraws every cancellation the cash payment queued,
  including one waiting to retry or one that has given up. A cancellation an
  edit had already queued before the cash payment is left alone, because the
  edit's reason for it still holds. The reversal's audit entry lists every
  cancellation it withdrew.
