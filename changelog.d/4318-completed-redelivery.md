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

  A card payment that reaches the app for the first time on a paid or
  completed booking that has no other payment holding money and no record of
  which payment settled it (a booking paid with account credit, at a zero
  total or by a group organiser, or one whose earlier payment was refunded) is
  now kept and flagged to the administrators, whatever its amount, rather than
  kept without a word. A repeat of a payment the app had already recorded is
  still acknowledged quietly.

  **After upgrading,** run the read-only query in the upgrade notes to list
  completed bookings that may hold a second card payment whose retries ran out
  before the upgrade, and check each in Stripe with the treasurer. An extra
  payment found there is refunded by hand in Stripe; the app records that
  refund and queues a Xero credit note, which must be deleted or voided in
  Xero until #4322 is fixed.
