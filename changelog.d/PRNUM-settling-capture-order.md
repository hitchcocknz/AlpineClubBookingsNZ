- **The Xero double-payment alert now always names the first card payment
  (#4163).** When a booking had been settled by card and its Xero invoice was
  then also paid by bank transfer, the admin alert names the card payment that
  settled the booking. If the booking held more than one card capture, which
  one the alert named was left to chance.

  It now names the earliest capture that no duplicate-capture refund is
  already returning. No money moves differently; only which capture the alert
  and its record point at is now predictable.
