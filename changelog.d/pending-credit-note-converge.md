- **A credit note used in Xero outside the app now fixes the app's credit ledger by
  itself (#4219).** When a treasurer uses a member's credit note directly in Xero
  (for example an offset against something the member owed) and the app tries to
  apply that same credit to a booking, the failed allocation used to sit under
  Active failures for good, with no button that could clear it. Now, when the
  allocation is retried and Xero confirms the credit was used, the app writes that
  credit down, stops counting it as applied to the booking, closes the failed rows
  and carries on with anything else the booking needs. The member's credit
  balance does not change, nothing is sent to Xero, and the amount the member now
  owes shows on the booking and on the Xero invoice for the usual follow-up. If
  the use in Xero was a mistake, reverse it there and retry: the credit allocates
  as normal. Anything the app cannot account for is left exactly as it was.
