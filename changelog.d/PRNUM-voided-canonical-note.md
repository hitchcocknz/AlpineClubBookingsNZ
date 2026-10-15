- **A bank-transfer refund note voided in Xero no longer still counts as the
  payment's live refund note (#4091).** When Xero voided the one refund credit
  note on a bank-transfer payment, the booking system kept that note's record
  active and the payment kept pointing at it, though Xero had cancelled it.

  The record now goes inactive when the void arrives, as it already did for
  card refunds, and the payment stops pointing at it. A voided note is never
  taken up again: if the refund's credit note is requested later, a fresh note
  is raised in Xero (Xero is never asked in a way that could hand the voided one
  back), and the booking repair tool no longer offers to point the payment back
  at the voided note.
