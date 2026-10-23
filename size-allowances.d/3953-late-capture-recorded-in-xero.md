# File-size allowances for #3953

A change's card capture that no supplementary invoice waited on is recorded
against the Xero invoice that bills it by a new outbox row. Its logic lives in
new modules (`additional-capture-xero-receipt.ts`, its enqueue, payload, link
and repair-finding modules); each file below only gains the line or two that
wires it in, at the one place that question is already answered for every
other queue type.

file: src/lib/stripe-webhook-service.ts
lines: 1777
reason: the charge-refunded handler is the one place a Stripe refund of a
  single capture queues its refund note, so it alone can name the invoice that
  capture's own receipt paid; one read through the receipt-link leaf and the
  note's existing `creditsInvoiceId` option.

file: src/lib/xero-booking-invoices.ts
lines: 1658
reason: the primary invoice create is the one writer of the figures stored
  with its link; it now passes through which captures its cash figure counted,
  read in its existing snapshot. One destructured name and one field.

file: src/lib/xero-booking-repair-classify.ts
lines: 2394
reason: the classifier is where every booking's findings are gathered before
  its summary is built; the new finding lives in its own module and this adds
  only its import and the one call beside the summary.

file: src/lib/xero-operation-outbox.ts
lines: 3343
reason: the outbox dispatch chain routes every queue type to its worker, and
  its census requires one branch per member of `XERO_OUTBOX_QUEUE_TYPES`; the
  new type's branch, its import and its constant.

file: src/lib/xero-operation-retry.ts
lines: 2076
reason: the retry module decides, per queue type, whether a row may be
  retried and sends outbox-run rows back on their own row; the receipt joins
  that same-row requeue (its stored payment kept) in the two places every
  other outbox-run type is answered.
