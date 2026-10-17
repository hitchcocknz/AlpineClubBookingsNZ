- **The app records which payment settled each booking, and refunds every
  other card payment on it (#4211).** When a second card payment lands on a
  booking that is already paid, the club refunds it automatically and alerts
  the admins. But once one such refund existed on a booking, any further
  payment was treated as the one that settled it. So when a member paid three
  times, for example from three old browser tabs, the club kept the third
  payment, with no alert and no task for anyone. Guessing which payment
  settled the booking could also go the other way: a repeat of the real
  payment's webhook could be refunded when a bank receipt or an older payment
  still held money.

  Now the payment that settles a booking is recorded when the booking turns
  Paid. It is never refunded automatically, however often Stripe repeats it.
  Every other card payment is refunded, each with its own alert and its own
  entry in the booking's admin history. The alert names the payment that
  settled the booking; the history entry names it too when the refund goes
  through straight away.

  Bookings paid before this release have no record. For those, when a card
  payment arrives while another payment on the booking still holds money,
  nothing is refunded automatically: the admins get an email asking them to
  check which payment to refund by hand. Nothing goes back through past
  bookings. Deploy note: the column is additive, and a booking the old colour
  settles during the switch is treated as paid before this release.
