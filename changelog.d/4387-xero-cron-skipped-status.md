- **Cron health no longer turns a Xero job amber over one routinely skipped
  row (#4375).** A Xero outbox or replay run that worked its batch, but passed
  over a row another caller had already claimed or finished, was recorded as
  SKIPPED and shown as a warning. It now records SUCCESS. SKIPPED is kept for a
  run that did no work because Xero is off or not connected, or had nothing to
  do. A run where Xero refused rows before any call (an outage cooldown, the
  daily limit or the environment check) still shows a warning, naming how many
  operations are waiting.
