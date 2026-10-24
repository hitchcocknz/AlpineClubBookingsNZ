- **A member whose account credit was used elsewhere in the club's accounts is now
  asked to pay for it.** When account credit applied to a lodge booking is found to
  have been spent in Xero outside the app, the booking is short by that amount and
  nothing used to ask for it. The member now gets a card payment request and one
  email, worded as "the credit applied to your booking was used elsewhere in the
  club's accounts" (not as a change to their stay). The card payment is recorded in
  Xero against the booking's own invoice, with no second invoice, and the request
  closes by itself when Xero shows the invoice paid by another route. Raising the
  requests starts switched off and is turned on by an operator after the deploy
  (see `docs/xero/ARCHITECTURE.md`); recording and closing are always on.
