# File-size allowances for #3973

file: src/lib/booking-cancel.ts
lines: 2817
reason: the cancel result gains the organiser refund the confirmation screen
  reads, and the organiser-card branch re-reads its debt's status after the
  inline run so a refund Stripe has not made is never reported as made; the
  result type, the claim's debt hand-off and the two branches that set it live
  here, so the lines cannot move without splitting the result from the code
  that builds it.

file: src/lib/group-cancel.ts
lines: 960
reason: one line computes the joiner email's refund line from this run's own
  settlement answers (the decision itself lives in the pure
  `group-settlement-refund-plan.ts`), and the email call passes the amount the
  sentence names beside `{{refundAmount}}`; the call site has to sit beside the
  email it feeds. Re-measured for #4042, stacked on this change: nine lines
  raise the organiser's hand-back inside the per-child claim that books each
  share (the writer itself is `group-organiser-hand-back.ts`), carry it out of
  the claim, name it in the child's audit and send its alert after the loop;
  each has to sit in the claim or the loop it belongs to.
