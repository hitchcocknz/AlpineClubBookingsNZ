- **A refund request's own Xero credit note that is voided in Xero is no longer
  treated as live (#4195).** When a refund request is paid back by bank
  transfer, the booking system raises that request's own refund credit note in
  Xero. If the treasurer then voided or deleted that note in Xero, the booking
  system still held it as the request's live note, so a retry of the
  request's note found it and raised nothing.

  The incoming Xero sync now marks a voided or deleted request note inactive,
  even when a retry is writing the same note at that moment, and the booking
  system never treats a voided note as the request's note again. Nothing
  raises a replacement automatically: the officer decides, because the note
  was voided for a reason. The booking repair tool no longer offers to retry
  such a request, and the Xero Operations panel may show its old failed row as
  repaired. Until the "Raise a fresh credit note" action arrives (#4214), raise
  the replacement by hand in Xero. When a request's note is raised again, it
  goes to Xero under a new key so that Xero cannot hand the voided note back.

  The refund itself is unchanged, because voiding the request's note does not
  undo the money the treasurer paid back. The booking repair tool still counts
  that refund against the request and never adds it to the cancellation's own
  refund note.

  Deploying: stop the previous release's Xero outbox and retry workers before
  this release takes over, and do not retry refund-request notes from the
  previous release during the switch, because it can take a voided note back.
  Before rolling back and after rolling forward, run the read-only check in the
  Xero architecture guide's #4195 deploy note, and check any request it lists
  in Xero.
