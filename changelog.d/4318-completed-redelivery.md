- **A card payment that arrives after a stay has ended is handled like one on
  a paid booking (#4285).** When Stripe sent the success of a card payment
  after the booking had moved to completed, the system refused it with an
  error, so Stripe kept retrying it for up to three days and the webhook log
  filled with failures. For the payment that paid for the stay that was only
  noise, but when a member had paid twice (for example from an old browser
  tab), the extra payment was not refunded automatically. Now it is: a repeat
  of the payment that settled the booking is acknowledged and changes nothing,
  and any other card payment is refunded automatically as a duplicate, or kept
  and flagged for an administrator to check when the system has no record of
  which payment settled the booking, just as on a paid booking.

  A single card payment on a paid or completed booking with no record of
  which payment settled it, and nothing else holding money, is now flagged to
  the administrators when its amount is not what the booking owes by card,
  rather than kept without a word: it may be a stray payment on a booking paid
  with account credit, a zero total or a group settlement. A repeat at the
  amount owed is still acknowledged quietly.

  **After upgrading,** run the read-only query in the upgrade notes to list
  completed bookings that may hold a second card payment whose retries ran out
  before the upgrade, and check each in Stripe with the treasurer.
