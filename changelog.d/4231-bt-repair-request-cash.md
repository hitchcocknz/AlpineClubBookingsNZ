- **A bank-transfer payment no longer forgets a refund request it already paid
  back when Xero sends an update (#4215).** When a refund request on a
  bank-transfer booking is paid back, the booking system records the refund on
  the payment and raises the request's own credit note in Xero. But whenever
  Xero then sent an update about the cancellation's refund credit note, the
  payment's account-credit note, or a booking change's credit note on its
  invoice, the booking system recounted the payment's refunded total and left
  out only the cash the refund requests had paid back. The payment then showed
  less refunded than the club had actually paid back.

  The recount now also counts every refund request the treasurer has marked
  paid back, at the amount recorded then. It does this while the request's
  note is still waiting to go to Xero, after Xero voids it, and when the
  request was paid back before the booking had a Xero invoice, so no note was
  ever raised for it. The request's refund is never added to the cancellation's
  credit note. Voiding the cancellation's credit note in Xero still removes that
  note's refund, as before.

  The booking repair tool now reads the same figure. Before, for a request paid
  back before the booking had a Xero invoice, it could offer a cancellation
  credit note that included the request's refund as well. It now leaves that
  refund out, and passes the cancellation's amount to a person when the two
  sit side by side.

  A payment that already lost a request's refund this way is corrected the
  next time Xero sends an update about the cancellation's credit note, the
  account-credit note, or a booking change's credit note on its invoice. An
  update about the request's own credit note does not trigger it. If you roll
  back to the previous release, it drops the request's refund again on the next
  such update; rolling forward corrects it the same way.
