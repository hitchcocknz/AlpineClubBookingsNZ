- **A card refund the card provider accepted and later reported as failed is
  now owed again (#4104).** The card provider can accept a refund as pending
  and fail it days later, for example when the member's card has been closed.
  The app counted such a refund as paid, so for a cancellation, a booking
  change or an approved refund request the member was never paid back and
  **Refunds owed** did not show it. Now the failed refund is taken back out of
  what was refunded, shows under **Refunds owed**, the officers are emailed
  once, and it is asked for again automatically. If that retry also fails
  later, it is listed for the treasurer to close as paid another way. A refund
  made by hand in the card provider's dashboard is not re-sent. **Operators:**
  add the `refund.failed` event to the club's card-provider webhook endpoint
  (see `DEPLOYMENT.md`); until then the payments cron still finds these refunds
  every 15 minutes.
