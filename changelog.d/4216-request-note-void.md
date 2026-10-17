- **A refund request's own Xero credit note that is voided in Xero is no longer
  treated as live (#4195).** When a refund request is paid back by bank
  transfer, the booking system raises that request's own refund credit note in
  Xero. If the treasurer then voided or deleted that note in Xero, the booking
  system still held it as the request's live note. A retry of the request's
  failed note then found it and raised nothing, so Xero ended up with no live
  note for that refund.

  The incoming Xero sync now marks a voided or deleted request note inactive.
  A retry of the request's note never reuses a voided one: it raises a fresh
  note in Xero, under a new key so that Xero cannot hand the voided note back.
  The refund itself is unchanged, because voiding the request's note does not
  undo the money the treasurer paid back, so the booking repair tool still
  counts that refund against the request and never adds it to the
  cancellation's own refund note. A request's note that was raised and
  completed normally is not raised again on its own after a void.

  Deploying: nothing to do. A request note voided before this release is read
  as voided from the status Xero recorded on it, so it needs no repair.
