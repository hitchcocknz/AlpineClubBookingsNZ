- **A bank refund recorded with "Paid another way" no longer disappears from the refunded total when a late card refund fails (#4280).**
  When the treasurer closed a card refund as paid another way, and the card
  refund Stripe had lost then turned up late and later failed, the app took
  the whole failed refund off the payment's refunded total. The bank refund
  still stood, but the total could fall to nothing, so the booking showed that
  money as kept and as refundable again. The total now never falls below the
  bank money "Paid another way" closes recorded: the full amount, or for a part
  close what was actually paid.

  Only these closes count. A cancellation's card refund shortfall and ordinary
  bank hand-backs are not counted, because a voided refund note can undo a
  hand-back while its task still reads completed.

  Payments a failure already took below a close's bank money are not changed
  automatically. The read-only `pnpm run payments:audit-refunded-total` report
  now lists them, with the bank money it counted, for the treasurer to review.
