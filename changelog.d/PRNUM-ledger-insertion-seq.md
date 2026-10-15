- **A payment's records now keep one order when two are written at the same
  moment** (#4132). Charges, payment requests and receipts saved together used
  to share a timestamp, and which came first then depended on the database's
  internal layout, which changes whenever one of them is updated. A new
  `PaymentTransaction.insertionSeq` column records the order they were saved in,
  and every money calculation now reads them by time, then that order. Where two
  records tie, "the latest" request is now the one saved last, so the payment
  summary, an edit's price reduction and the ledger census always agree on which
  request is live, and a card refund split across charges saved together
  refunds the last one first. The upgrade numbers existing records in the order
  they are read today, so nothing already stored changes order. Operators: the
  migration briefly locks the payment records table (measured at about 1.5 to
  3 seconds per 100,000 records); see `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` for
  the pre-deploy check on open card refunds.
