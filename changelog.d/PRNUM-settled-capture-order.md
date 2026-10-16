- **"Duplicate card capture auto-refunded" now names the same settling payment
  every time (#4177).** When a second card payment lands on a booking that is
  already paid, the club refunds it automatically and tells the admins which
  card payment had settled the booking, in the alert email and in the
  booking's admin history. If the booking held more than one payment that
  could have settled it, which one was named was left to chance.

  It now names the earliest one, the same rule the "paid twice — card and
  Xero" alert follows (#4163). No money moves differently: the arriving
  duplicate is still the only payment refunded. This applies to refunds made
  from this release; history already recorded keeps the payment it named.
