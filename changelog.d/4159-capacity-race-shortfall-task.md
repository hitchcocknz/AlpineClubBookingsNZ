- **A card payment refunded short after the dates filled up is now a task to
  check (#4154).** When a member's card payment completes after the last beds
  went, the booking is cancelled and the card refunded automatically for what
  the payment's records show can go back to the card. When that was less than
  the charge, or nothing, officers were emailed but nothing in the app tracked
  the rest, and the member's page kept saying the club would be in touch.
  The rest now appears in **Money to settle** as a part to check, the same as
  a card cancellation's. Check Stripe and the bank first, since the records may
  be wrong and the money may already have gone back: dismiss it with a note if
  it has, and the member's page says the club checked it and closed it. If it
  really is owed, try **Mark paid back** before you pay, once the card refund
  has gone through. The app records it only on that card charge. Where the
  charge's records read more refunded than the card refunds on record, it
  corrects them itself first and logs that in the audit log (under Payment,
  which finance officers read), but only for a
  charge made since the app kept a record of each card refund, on a booking
  with no account credit given back and no other refund task. If it accepts,
  pay it by bank transfer straight away: the app records the refund on the
  booking's ledger, queues its Xero refund credit note, and the member's page
  says the whole payment was refunded. If it refuses, it says why: pay the
  member anyway if they are owed, dismiss the task with a note saying when and
  how much, and raise the Xero refund credit note by hand. The officers' email
  now points at the task.
