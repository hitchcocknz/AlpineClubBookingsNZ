- **A late card payment refunded automatically is now always recorded, even if
  the server stops mid-way (#4149).** When a card payment arrives after its
  booking was cancelled, the app refunds it and then records that refund for the
  finance team: the "Refunded automatically" entry, the audit log line, the
  admin alert and the Xero correction. If the server stopped, or the entry could
  not be saved, after the refund went out, that entry was never written - and
  the nightly Xero check then raised a credit note for the whole payment against
  the booking's original invoice, for money Xero never received. Now the alert
  and the audit line still go out at the time, and the missing entry is saved
  when Stripe next sends the payment notice, or by the nightly check before it
  raises any credit note; a payment it cannot check that night gets no credit
  note until it can. A hand-back task still open for that payment is closed
  rather than left asking someone to repay money Stripe already returned. The
  late entry is dated the day the money went back, and it sends no second
  alert - unless the server stopped before the first one went out.
