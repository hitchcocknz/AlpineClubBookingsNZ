# File-size allowances for #3980

An ordinary edit that read no primary Xero invoice link now claims the payment
row against it, and the invoice create measures the booking's whole worth at
its link. The rules live in their own modules (`booking-primary-invoice-claim.ts`,
`xero-primary-invoice-fee-gap.ts`, `xero-primary-invoice-review-task.ts`), and
`booking-modify-settlement.ts` stays inside its budget by moving
`resolveSelectedSettlementAmount` verbatim beside the options it reads. What
each file below adds is only the wiring that has to sit where the edit's
history row, or the create's read, already is.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1697
reason: this door settles for itself instead of through
  `applyPaymentAdjustments`, so its claim on the payment row and its history
  row's marker have to sit in its own transaction beside its settle step.

file: src/lib/booking-batch-modification-service.ts
lines: 2927
reason: its history row carries the marker, and a finished-stay correction
  passes its own refusal wording to the shared settlement.

file: src/lib/booking-date-modification-service.ts
lines: 2389
reason: its history row carries the marker the gap check anchors on; the row
  is written inline here and nowhere else.

file: src/lib/booking-guest-removal-service.ts
lines: 1512
reason: its history row carries the marker the gap check anchors on; the row
  is written inline here and nowhere else.

file: src/lib/xero-booking-invoices.ts
lines: 1659
reason: the create's own read is the worth it built from, so the figure is
  taken here, where the read and the lines are, and handed to the link's save.
