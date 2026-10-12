- **An organiser's cancel of a group paid by Internet Banking now asks an
  officer to repay the organiser (#4042).** The cancel already recorded each
  joiner's refund in the app's ledger, and each joiner's email says the club
  will repay the organiser directly, but nothing asked anyone to send the
  money. The cancel now raises one task in **Money to settle** on the payments
  board, on the organiser's booking, and adds each joiner's share to it as
  their place is cancelled, listing the shares. Admins get the **Manual refund
  needed** email once, worded for a group (the cash-booking wording is
  unchanged). Re-running the cancel adds nothing twice. Marking the task paid
  back records only that the money went, because the refunds are already in
  the ledger; it cannot be dismissed, and an officer who would not repay is
  sent to the treasurer. When the group's paid Xero invoice cannot be voided,
  that alert now points to the task and its amount rather than the invoice's
  paid total. The "Manual refund needed" message gains three tokens,
  `{{handBackNote}}`, `{{handBackLabel}}` (now required in the subject) and
  `{{handBackRecipientLabel}}`; a club that customised it keeps its own wording
  until it adds them.
