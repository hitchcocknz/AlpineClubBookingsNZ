- **A card payment refunded short after the dates filled up can now be
  recorded when the club repays the rest (#4154).** When a member's card
  payment completes after the last beds went, the booking is cancelled and the
  card refunded automatically for what the payment's records show can go back
  to the card. When that was less than the charge, or nothing, officers were
  emailed but had no way to record repaying the rest: no task, no ledger line,
  no Xero note, and the member's page kept saying the club would be in touch.
  The rest now appears in **Money to settle** as a part to check, the same as
  a card cancellation's. Check Stripe and the bank first, since the records may
  be wrong and the money may already have gone back: dismiss it with a note if
  it has, and the member's page says the club checked it and closed it. If it
  really is owed, pay it by bank transfer and mark it paid back once the card
  refund has gone through; that records the refund on the booking's ledger,
  queues its Xero refund credit note, and the member's page says the whole
  payment was refunded. The officers' email now points at the task.
