# File-size allowances for #4102

The rule of what an approved refund request still owes after its inline card
refund lives in `inlineRefundNotMade` (`refused-card-refund-retry.ts`), beside
the edit doors' and the runner's; what stays in the route is the call, the
refusal's log line and the officers' alert at the two places the recovery row
is or is not written.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 748
reason: the refusal alert has to sit at the enqueue it depends on - once
  when this approval wrote the row, and in the branch that releases the claim
  when no row could be written - so it cannot move out without moving the
  enqueue and the claim release (one `lock(1)` transaction) with it. The
  attempt now hands its answer, thrown or returned, to one reader instead of
  the catch block computing a remainder.
