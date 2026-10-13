- **A card cancellation whose card refund cannot cover the whole refund now
  records the rest as owed, and tells the member so (#4097).** A cancellation
  refunds to the card only what the payment's card charges can still give back.
  When that was less than the refund the cancellation policy gives, usually
  because the payment's records disagree, the difference was only written to
  the server log: nothing recorded it as owed, and the member's email and the
  cancel screen said the whole refund had been made. Now the cancellation
  raises a refund task for the difference on the payments board, counted in
  "Refunds owed", and the treasurer is emailed once. The email and the cancel
  screen name what went to the card and say the club will refund the rest by
  bank transfer. The card refund's booking history and its Xero refund credit
  note are for what the card actually refunded. Marking the task paid back
  raises one Xero refund credit note for exactly that amount, worded as a bank
  transfer, so Xero shows both parts of the refund.

  For treasurers: check the payment in Stripe. If the member has not had the
  money, pay it by bank transfer and mark the task paid back. If it was
  already refunded another way, dismiss the task with a note.
