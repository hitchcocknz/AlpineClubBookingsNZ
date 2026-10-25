- **Members asked to pay for account credit used elsewhere are now reminded
  weekly, can pay by bank transfer, and the older cases are picked up.** The
  request for credit that was used elsewhere in the club's accounts is emailed
  at once, then every 7 days, four times in all; after that only the officers'
  queues chase it, and the reminders carry on after the stay has ended. Where the
  club has written its bank details (a new "Bank transfer details for a payment
  request" message under Admin → Booking messages), the email offers a bank
  transfer as well as card, quoting the booking's Xero invoice number as the
  payment reference, and the request closes when Xero shows the invoice paid.
  Every screen and email now says why a request exists (a booking change, credit
  used elsewhere, or both, when a change was made while the request was unpaid and
  the two became one). Credit released before the requests were switched on can be
  asked for in small, audited batches behind a second switch (see
  `docs/xero/ARCHITECTURE.md`); each is re-checked against Xero first, so nothing is
  asked that is no longer owed.
