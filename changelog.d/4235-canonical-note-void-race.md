- **A payment's refund credit note voided in Xero now stays inactive even when
  a retry is recording it at that moment (#4223).** When a cancelled booking's
  refund was handed back, the booking system keeps one refund credit note in
  Xero for the payment. If the treasurer voided that note in Xero just as a
  retry of the refund's note was recording it as already raised, the retry
  could mark the voided note live again and point the payment back at it.
  Nothing was counted twice, because every refund total reads the note's
  voided status, but the payment's record named a note Xero had voided until
  the nightly link cleanup put it right.

  The retry now waits for the incoming Xero sync and then keeps the void: the
  note stays inactive even if its mirror was missing, its voided status is
  kept, and the payment no longer points at it. The same rule already covered a refund request's own note
  (#4195), and now covers card payments' notes too.

  Deploying: no database change. Stop and drain old refund-note workers and
  web/direct retries before enabling new refund-note writes; the old and new
  canonical writers take row locks in different orders. Rollback requires the
  same drain in reverse (see the Xero architecture guide's deploy note).
