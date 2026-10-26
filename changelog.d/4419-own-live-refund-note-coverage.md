- **A refund's Xero credit-note check now counts only that refund's own live
  note (#4265, #4258, #4321).** The app checks, for each bank-transfer refund,
  whether Xero holds a live credit note covering it. Three things could make
  that check read "covered" when the refund was not.
  - A refund request's own note, resolved by hand in Xero, was counted towards
    the payment's other refunds, and kept counting even after it was voided.
    For example, a $300 request note made a voided $200 cancellation note look
    spare, so the nightly check left a $200 refund with no credit in Xero.
  - A refund closed as "covered by another refund's note" was credited with
    that other refund's whole note.
  - A credit note already recorded against one refund, resolved by hand, could
    also be accepted as the hand-made note for another.

  Now a refund counts only its own live note, never a refund request's. Such a
  void is undone and put back on the refund list as owed, as the nightly check
  intends. Answering "already recorded it in Xero myself" with a note that
  another refund already records is refused with a plain message, and nothing
  is recorded. Refunds that had been wrongly treated as covered surface on the
  next nightly run; nothing is changed retrospectively by this release.
