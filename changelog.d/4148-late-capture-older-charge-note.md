- **A late card payment on a cancelled booking is now refunded from that payment
  itself, never from a fee the cancellation kept (#4131).** Take a booking paid by
  a second card charge, where the first payment went through after the booking was
  cancelled. The automatic refund could come partly off the second charge, which
  held the cancellation fee the club kept. The late payment then kept that same
  amount. The member always got the right total back, but Xero could not follow it:
  the nightly refund-note check raised a credit note against the booking's
  original invoice, leaving the Stripe account in Xero short by that amount. The
  refund now always comes off the late payment's own charge, and only for what it
  still holds, so the cancellation fee stays where it was and no extra credit note
  is raised for any late payment refunded on this release. A refund the previous
  release had already split this way is unchanged and is still noted by the
  nightly check, as before.

  A late payment whose refund was part-way through when this release was deployed
  finishes as it started, without refunding anything twice. The refund's activity
  entry now says how much went back now and where the rest of the payment went
  back. **Deploy limit:** do not roll back across this release while a late
  payment on a cancelled booking is waiting to be refunded (see `docs/UPGRADING.md`).
