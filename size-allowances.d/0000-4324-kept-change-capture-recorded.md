# File-size allowance for #4324

#4324 records a late card payment for a booking change that a treasurer kept
on a cancelled, invoiced booking. The decision lives in
`src/lib/late-capture-kept-xero.ts`, the receipt's kept-capture rules in
`src/lib/kept-late-capture-change-receipt.ts`, and the repair tool's finding,
loader and action in `src/lib/xero-booking-repair-additional-capture.ts`,
beside the change capture finding they extend. The worker grew past its
budget, so its pure Xero-read helpers moved to
`src/lib/additional-capture-receipt-invoice-read.ts`. What remains below is
one call in the classifier.

file: src/lib/xero-booking-repair-classify.ts
lines: 2398
reason: the kept-capture loop already decides, per kept late capture, whether
  the kept-capture invoice records it; a change capture on an invoiced booking
  now goes to its own finding from that same branch (one call, one comment, and
  its import merged into an existing line). Lifting the kept-capture loop out
  of the classifier is a refactor of its own, and a second loop over the same
  kept captures would read each one twice.
