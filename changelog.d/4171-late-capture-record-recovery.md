- **A late card payment refunded automatically is now always recorded, even if
  the server stops mid-way (#4149).** When a card payment arrives after its
  booking was cancelled, the app refunds it and then records that refund for the
  finance team: the "Refunded automatically" entry, the audit log line, the
  admin alert and the Xero correction. If the server stopped, or the record could
  not be saved, after the refund went out, that record was never written - and
  the nightly Xero check then raised a credit note for the whole payment against
  the booking's original invoice, for money Xero never received. Now Stripe's
  next delivery of the payment writes the missing record, and the nightly check
  writes it too before it raises any credit note; a payment it cannot check that
  night gets no credit note until it can. Each refund is recorded, alerted and
  noted in Xero once, however many deliveries or checks race.
