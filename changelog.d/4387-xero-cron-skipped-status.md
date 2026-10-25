- **Cron health no longer turns a Xero job amber over one routinely skipped
  row.** A Xero outbox, replay or inbound run that worked its batch, but passed
  over a row another caller had already finished or claimed, was recorded as
  SKIPPED and shown as a warning. It now records SUCCESS; SKIPPED is kept for a
  run that did no work because Xero is off, not connected, or had nothing to
  read.
