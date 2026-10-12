- **Finance diagnostics now say what a group joiner's refund is.** A refund queued
  to the group organiser's card (for a joiner's booking edit, a group cancellation
  or an approved refund appeal), a retry of an older whole-group refund, an
  officer-confirmed edit refund or charge, and an approved late-capture refund
  were all reported as an unrecognised recovery. Each now carries its own scenario
  code and a plain-English label, and a test fails if a recovery key is ever added
  without one. Read-only diagnostics; no behaviour change to payments.
