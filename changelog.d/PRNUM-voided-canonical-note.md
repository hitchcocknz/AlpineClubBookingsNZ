- **A bank-transfer refund note voided in Xero no longer still counts as the
  payment's live refund note (#4091).** When Xero voided the one refund credit
  note on a bank-transfer payment, the booking system kept that note's record
  active and the payment kept pointing at it, though Xero had cancelled it.

  The record now goes inactive when the void arrives, as it already did for
  card refunds, and the payment stops pointing at it. Nothing is created, voided
  or changed in Xero.
