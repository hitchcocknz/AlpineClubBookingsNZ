- **A card refund the card provider refuses is no longer lost (#4083).** When a
  booking change lowered the price of a booking paid by card, and the card
  provider answered the refund straight away as failed or cancelled (rather
  than with an error), nothing was queued to try again and the treasurer's
  **Refunds owed** did not show it, so the member might never get the money. A
  cancellation's refund refused the same way was marked as paid. Now the
  refused amount stays owed: it counts in **Refunds owed**, it is retried
  automatically (each retry is a fresh request, so the provider does not just
  repeat its earlier refusal), and if the retries run out it is listed for the
  treasurer to close as paid another way, as any other card refund that could
  not be made is. This covers every change that can refund the member's card -
  changing dates, removing a guest, a combined edit, a re-price after a guest
  accepts - and a cancellation.
