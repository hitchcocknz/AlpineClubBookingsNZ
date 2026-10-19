- **A credit note used in Xero outside the app now fixes the app's credit ledger by
  itself (#4219).** When a treasurer uses a member's credit note directly in Xero
  (for example an offset against something the member owed) and the app then tries
  to apply that same credit to a booking, the failed allocation used to sit under
  Active failures for good, with no button that could clear it. Now, when Xero
  refuses the allocation and the app confirms the credit was used, it writes that
  credit down, stops counting it as applied to the booking, closes the failed rows
  (they show as closed with the reason) and carries on with anything else the
  booking needs. The member's credit balance does not change and nothing is sent to
  Xero. Only credit used on things the app has no record of is counted; credit used
  on another of the club's own invoices is left to the existing sync.

  The booking now owes the released amount, and the Xero invoice shows it unpaid;
  collect it as usual. An email asking the member to pay it follows in a later
  release. Anything the app cannot account for is left exactly as it was, and if
  the use in Xero is later reversed the credit does not come back automatically
  yet.
