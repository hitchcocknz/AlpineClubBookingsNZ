- **The retry of a lost card request for a price increase now looks for the
  earlier request more narrowly (#4079).** When a paid booking's price goes up
  and Stripe refuses the automatic retry of the card request, the retry looks
  for the request Stripe already made. It used to also accept one labelled the
  way the previous version of the retry labelled its own requests; no such retry
  is left, so it no longer does, and it only looks at requests made around the
  time the original one failed. On a very busy Stripe account the search no
  longer gives up and alerts an administrator just because of the number of
  later card requests. Nothing needs doing.
