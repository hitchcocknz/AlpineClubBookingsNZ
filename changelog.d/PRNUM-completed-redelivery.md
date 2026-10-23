- **Stripe's repeat of a card payment for a finished stay is answered as
  already paid (#4285).** When Stripe sent the success of a card payment again
  after the stay had ended and the booking had moved to completed, the system
  refused it with an error, so Stripe kept retrying it for up to three days and
  the webhook log filled with failures. No money moved. A completed booking is
  now treated exactly like a paid one: a repeat of the payment that settled it
  is acknowledged and changes nothing, and any other card payment on it is
  refunded automatically as a duplicate, or kept and flagged for an
  administrator to check when the system has no record of which payment
  settled it, just as on a paid booking.
