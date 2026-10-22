- **A second refund handed back on a bank-transfer booking now gets its own
  Xero credit note (#4287).** When a bank-transfer payment already had its
  refund credit note in Xero, a cancellation refund the treasurer handed back
  later was counted under that first note and Xero never got a note for it, so
  Xero showed less credit than the club had paid back. Each such refund now
  gets a credit note of its own, for exactly that refund's amount. The same
  applies to the first refund handed back on a bank-transfer payment that also
  had part of it refunded to a card, where the first note's amount could
  otherwise come out wrong.

  Nothing is raised for refunds handed back before this release: the
  read-only query in the deploy notes still lists those payments so their
  notes can be raised by hand. A refund appeal's card-refunded part, a card
  refund made in the Stripe dashboard and a late card capture's refund on a
  bank-transfer payment are not changed yet and still need checking by hand.
