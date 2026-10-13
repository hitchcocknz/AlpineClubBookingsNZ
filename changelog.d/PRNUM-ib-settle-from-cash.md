- **A bank-transfer booking now records the money its Xero invoice actually
  collected** (#3979). When Xero reports a booking's invoice paid, the app
  records the cash that invoice took, so a booking whose price (or a recorded
  change fee) changed before its invoice was raised is no longer settled at its
  old price, and its refunds and account credits are sized from what was paid.
  If the app cannot tie that figure to the booking alone, it keeps the figure it
  had and emails the admins; it also emails them when what was paid is not what
  the booking owes. A credit note that lowers an invoice nobody has paid yet
  (*Invoice correction — nothing refunded*) is now a price correction, not a
  refund: a $300 invoice cut by $100 and paid $200 shows $200 paid and nothing
  refunded. Bookings settled before this change are not rewritten;
  `pnpm run payments:audit-ib-settled-cash` lists any whose figure differs from
  the cash Xero recorded, for the treasurer to correct by hand.
