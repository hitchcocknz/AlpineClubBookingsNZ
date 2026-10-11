# File-size allowances for #3973

file: src/lib/booking-cancel.ts
lines: 2810
reason: the cancel result gains the organiser destination (`refundTo`, and the
  group cancellation's owed refund) that the confirmation screen reads; the
  result type and the two branches that set it live here, so the five lines
  cannot move without splitting the result from the code that builds it.

file: src/lib/group-cancel.ts
lines: 949
reason: one line computes the joiner email's refund line from this run's own
  settlement answers (the decision itself lives in the pure
  `group-settlement-refund-plan.ts`); the call site has to sit beside the email
  it feeds.
