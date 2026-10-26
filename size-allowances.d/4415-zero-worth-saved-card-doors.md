# File-size allowances for #4399 - the $0 saved-card doors

Both routes are already over the route-handler budget and grew in #4394
(`size-allowances.d/4394-saved-card-charge-worth.md`). Each gains only the
guard this issue needs, at the one place it can sit: inside the transaction
that holds the locks it relies on.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 948
reason: the $0 branch's Payment write moves inside its locked claim (net +1,
  the one-line note saying why); splitting the lock-ordered transaction out of
  the route is a refactor this fix does not otherwise need.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 668
reason: the worth-is-zero refusal (+4) must read the under-lock re-read beside
  the card check, inside the claim transaction that is the route's body.
