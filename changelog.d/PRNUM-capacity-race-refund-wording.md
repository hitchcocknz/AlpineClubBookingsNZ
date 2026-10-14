- **A booking cancelled because the dates filled up while the member was
  paying no longer says "refunded" before the refund is made (#4125).** The
  cancellation is recorded before the card refund is attempted, and it used
  to say the booking was "cancelled and refunded". Now it says the full amount
  "is being refunded", and the refund is recorded once it is actually made.
  If the card refund fails or the card provider refuses it, the app keeps
  retrying it, and the booking page now says the amount "is on its way back
  to your original payment method" rather than "no refund was due".
