- **A group joiner's bank-transfer refund no longer disappears when its Xero
  credit note is voided (#4290).** When an organiser cancels a group they paid
  for by Internet Banking, each joiner's refund is recorded on the joiner's own
  booking. If that joiner's refund credit note was later voided in Xero, or
  Xero showed less than the refund, the app quietly lowered the joiner's
  refunded total to match Xero, with no alert, and could even show the joiner's
  payment as fully paid again. The app now keeps the refund it recorded, as it
  already does for any other bank-transfer refund: a voided note waits for the
  nightly follow-up and is listed on Stuck States for the treasurer to answer,
  and any other shortfall in Xero raises the usual Xero sync alert.
