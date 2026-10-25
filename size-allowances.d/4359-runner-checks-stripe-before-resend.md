# File-size allowances for #4359 (the recovery runner reads Stripe before a card refund send)

The check itself - the read, the record and the hold's decision - is a new
module written to its own ceiling (`card-refund-resend-stripe-check.ts`). Each
entry below is the seam into an existing flow, which belongs where that flow is.

file: src/lib/payment-recovery.ts
lines: 3409
reason: the check is called in the two processors that send a card refund,
  immediately before their send (a census pins both call sites), and a hold
  ends the row through the one terminal transition
  (`failPaymentRecoveryOperation` -> `markPaymentRecoveryOperationFailed`,
  `INV-PAY-056`), which is private to this module by design: its alert takes
  the hold's own words and amount, and the hold is audited only when that
  write lands.

file: src/lib/stripe-webhook-service.ts
lines: 1791
reason: `charge.refunded`'s record-and-note step is split from its listing so
  the runner records a refund the app has not seen exactly as the webhook
  does (`INV-SSOT`); moving it out would carry its late-capture and Xero-note
  branches, and every census that reads them in this file, with it.
