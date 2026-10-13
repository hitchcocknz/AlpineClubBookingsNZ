- **Account credit is now used in the same order every time (#4013).** When a
  member's account credit is applied to a booking, the system uses their
  oldest credit first. Two pieces of credit recorded at exactly the same moment
  could previously be used in either order, so the same booking could
  sometimes use an existing Xero credit note and sometimes create a new one.
  Credit recorded at the same moment is now always used in the same fixed
  order. No amounts change.

  One case now stops instead of guessing: if an allocation that was
  interrupted before this upgrade is retried after it and would now pick a
  different piece of credit, the Xero operation fails with a message naming
  the booking, and nothing is allocated twice. Compare that booking's credit
  notes in Xero with its allocations before retrying it.
