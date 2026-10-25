- **The payment recovery job no longer refunds a card twice when someone has
  already refunded it in the Stripe dashboard (#4359).** When the app still
  owed a card refund - most often one Stripe accepted and then failed days
  later - and a treasurer refunded that payment in the Stripe dashboard before
  the app tried again, the app sent its own refund anyway. The member was paid
  twice and nothing said so.

  Before it sends any card refund, the recovery job now reads the refunds
  Stripe holds on that payment, and records any the app had not seen yet, with
  their Xero credit note, as Stripe's own refund notice would. If Stripe holds
  a refund made outside the app since this refund became owed, the app sends
  nothing. It stops the refund, emails the officers, and records it in the
  audit log; on Stuck States it shows under **Exhausted recovery operations**
  and, while anything is still owed, under **Card refunds Stripe gave up on**
  marked "Stripe may have refunded". Check the dashboard refund in Stripe: if
  it paid the member back, nothing more is owed; if it did not, pay the member
  with **Paid another way**, not with another dashboard refund. If Stripe
  cannot be reached, nothing is sent and the job tries again later.
