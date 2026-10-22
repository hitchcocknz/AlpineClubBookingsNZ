- **The "refund ledger divergence" alert for a bank-transfer payment now says
  what is usually wrong, and how to fix it (#4230).** When Xero's refund credit
  notes for a bank-transfer payment add up to less than the refunds the club
  recorded on it, the booking system keeps its own record and alerts the
  treasurer. The alert used to blame a credit note voided in Xero. It can also
  mean a refund has no credit note of its own: when a payment already has its
  refund credit note, a later refund on it - a second cancellation refund, or
  the card-refunded part of an approved refund appeal - is counted under that
  first note and Xero never gets a note for it. The alert now names both causes
  and asks for the missing note to be raised by hand in Xero, and the Xero
  guide's troubleshooting table quotes it. The payment keeps the club's own
  record of its refunds, as before. Nothing changes in how notes are raised;
  giving each later refund its own note is a separate change.

  The deploy notes add a read-only query that lists bank-transfer payments
  whose paid-back refunds add up to more than their refund credit notes, so
  officers can raise the missing notes by hand. Tests now pin, against a real
  database, that a group organiser's repayment and the recount's handling of a
  payment's charge records were already safe, and the current handling of a
  later refund on a bank-transfer payment.
