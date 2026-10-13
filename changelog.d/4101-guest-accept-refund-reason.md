- **A card refund after a guest's acceptance lowers a booking's price now
  recovers if the first attempt is interrupted (#4101).** When a guest accepting
  their place re-prices a paid booking down, the club refunds the difference to
  the card. If that refund was interrupted after the card provider had already
  made it (a timeout, for example), the background retry sent a slightly
  different request under the same reference, the provider refused it, and the
  retry never finished, so the refund stayed listed as owed although the money
  had gone back. The retry now sends exactly the original request, so it picks up
  the refund already made and records it. No member is refunded twice. The other
  refund retries were checked and already matched their original requests.
