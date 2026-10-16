- **The nightly Xero link cleanup now repairs refund credit notes voided in
  Xero before #4091 (#4161).** If a bank-transfer payment's refund credit note
  was voided in Xero before that fix, the booking system still held it as the
  payment's live refund note. Neither the nightly cleanup nor the reconciliation
  report noticed.

  The cleanup now finds every refund note that Xero records as voided or deleted
  but that is still held as live, on any payment. It marks each one inactive and
  stops the payment pointing at it, through the same step an incoming Xero void
  uses. Its run summary counts how many it found, and until then the
  reconciliation report lists them as stale links. No money moves, and a second
  run changes nothing. On a card payment whose latest note was voided, the
  payment now also points at its newest live note.
