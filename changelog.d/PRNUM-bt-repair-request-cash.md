- **A bank-transfer payment no longer forgets a refund request it already paid
  back when Xero sends an update (#4215).** When a refund request on a
  bank-transfer booking is paid back, the booking system records the refund on
  the payment and raises the request's own credit note in Xero. But whenever
  Xero then sent an update about the cancellation's own refund credit note,
  the booking system recounted the payment's refunded total from that note
  alone. The request's refund dropped out, so the payment showed less refunded
  than the club had actually paid back.

  The recount now also counts every refund request the treasurer has marked
  paid back, at the amount recorded then. It does this while the request's
  note is still waiting to go to Xero and after Xero voids it. The request's
  refund is never added to the cancellation's credit note. Voiding the
  cancellation's credit note in Xero still removes that note's refund, as
  before.

  A payment that already lost a request's refund this way is corrected the
  next time Xero sends an update about one of its credit notes. If you roll
  back to the previous release, it drops the request's refund again on the
  next such update; rolling forward corrects it the same way.
