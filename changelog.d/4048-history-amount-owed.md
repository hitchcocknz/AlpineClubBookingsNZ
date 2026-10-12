- **The booking page and the payment step now agree on what is owed
  (#3991).** While the club is checking the money for a change a member made,
  the summary at the top of the booking page shows the amount still to pay.
  It used to show the booking's price on its own, leaving out any change fee an
  officer had recorded and any account credit already applied. It now shows
  what is actually owed: the price plus any recorded change fee, less applied
  credit. That is the same figure the card payment and the emailed payment link
  charge. When credit covers everything, it says there is nothing left to pay
  and names no amount.

  A guest on someone else's booking is no longer shown the owner's account
  credit in that summary, nor the "Saved account credit was not applied" entry
  in the booking's history, matching the credit-choice notice they already did
  not see.

  The page's pay card, and the `{amountDue}` wording in the club's booking
  messages, now take the applied credit from the same record as the payment
  step, so all three agree. Nothing about what is charged changes.
