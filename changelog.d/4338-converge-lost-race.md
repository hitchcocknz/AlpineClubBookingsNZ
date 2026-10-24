- **Two Xero tasks for the same document started at the same moment no longer
  fail one of them by mistake (#4338).** The app keeps at most one live Xero
  task per document. When two parts of the app tried to start the same task at
  once, the second was told to use the first one's task, but if the first had
  already finished in that split second, the second failed with a database error
  instead. The clearest case was applying a member's credit to a booking twice
  at once while the credit note had been used in Xero outside the app: the
  ledger was brought into line correctly, but one run still showed as failed.
  The second task now simply starts its own attempt, exactly as it would have a
  moment later, so nothing fails. No credit balances, invoices or Xero records
  change, and there is nothing for an officer to do.
