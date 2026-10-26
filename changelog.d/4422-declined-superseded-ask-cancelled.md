- **A later change now cancels an earlier declined card payment too, so it
  cannot be paid twice (#4422).** When a member's card was declined for an
  extra booking charge and a later change replaced that charge, the declined
  one was marked failed in the booking system but left open at Stripe. A
  browser tab still showing it could then pay it, charging the member for both
  and, once the later charge was paid, recording one of the two in Xero
  nowhere. The declined charge is now cancelled at Stripe like any other
  replaced charge. If the old tab manages to pay it in the moment before the
  cancel lands, that payment is refunded automatically (or held for the
  treasurer where the club requires it), as for any replaced charge paid late.
