- **A "Booking Cancelled" email no longer says a refund to the member's own
  card "has been processed" before it has (#4084).** When a member cancelled a
  booking paid by card and the card refund failed, timed out or was refused by
  Stripe, the email and the cancel confirmation still said the refund had been
  processed. They now say so only once the card refund has gone through;
  otherwise they say "A refund of $X is on its way to your original payment
  method.", shown as information rather than as a success. An officer
  cancelling on the member's behalf sees "the member's original payment
  method". The same rule now decides this for "Booking Modified" (#4070) and
  "Booking Cancelled". Refunds as account credit, by bank transfer or to a
  group organiser's card keep their existing wording.
