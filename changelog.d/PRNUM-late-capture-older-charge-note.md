- **A late card payment on a cancelled booking is now refunded from that payment
  itself, never from a fee the cancellation kept (#4131).** When a booking was
  paid by a second card charge and the first payment went through after the
  booking was cancelled, the automatic refund could take part of the money back
  from the second charge, out of the cancellation fee the club had kept, and
  keep the same amount of the late payment instead. The member always got the
  right total back, but Xero could not follow it: the nightly refund-note check
  then raised a credit note against the booking's original invoice, leaving the
  Stripe account in Xero short by that amount. The refund now always comes off
  the late payment's own charge, and only for what it still holds, so the
  cancellation fee stays where it was and no extra credit note is raised. A late
  payment whose refund was already part-way through when this release was
  deployed finishes exactly as it started, without refunding anything twice.
