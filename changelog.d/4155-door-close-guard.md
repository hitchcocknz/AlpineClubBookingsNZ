- **A card refund that failed later is no longer marked paid by the refund that
  first sent it (#4144).** When a cancellation, a booking edit's financial
  review, a duplicate-capture refund or a capacity-race refund was made at
  Stripe, the app closed its "refund owed" record straight away. In a narrow
  window - the automatic retry had already picked the record up, and Stripe
  then reported the refund as failed - that close could mark the money paid
  while it was still owed, so "Refunds owed" stopped counting it. The close
  now happens only while the record still holds exactly the refund it sent;
  a record that has since been re-planned stays open and is retried. Nothing
  changes for an operator: the officers are still alerted to the failed
  refund, and an unexpected missed close is logged and, if nothing else has
  touched the record, alerted once.
