# File-size allowances for #4019 (whole-lodge payment options)

The whole-lodge approval now leaves the payment method to the member. Every
file below is an existing seam that change had to pass through; each grows by a
few lines of policy inside a decision the file already owns, and none of them
gains a boundary a split could sit on.

file: src/lib/school-booking-request.ts
lines: 3219
reason: the member-choice branch (apply the elected credit, settle at $0
  when it covers the price, or keep the legacy receivable) sits inside the
  one approval transaction, under the locks it already holds; lifting it out
  would separate the money decision from the capacity claim and the
  idempotency fence it is ordered against, which is the pairing the
  #2263 owner decision placed in this file on purpose.

file: src/lib/booking-request.ts
lines: 3090
reason: the request's credit election is one field on the creation write and
  one on the admin serialiser, beside the exclusivity flag it travels with;
  a new module for a boolean would put the request's shape in two places.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 557
reason: the whole-lodge case is a two-line hold exemption and a shared
  status predicate inside the existing lock-ordered switch; a second route
  would duplicate the card-intent retirement and the credit netting it
  must stay in step with.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2718
reason: one optional field on the request type, one prop pass-through and
  two toast branches; the panel is the queue's single composition root and
  the #2263 controls already live in their own file beside it.

file: src/lib/email/booking.ts
lines: 1811
reason: the pay-online shape is a type swap and a spread at the two places
  the sender composes the payment-due note; the composer itself lives in
  email-payment-due-note.ts (moved there whole from email-message-notes.ts,
  which sits at its ceiling), which is where the new wording went.

file: src/lib/admin-bookings-service.ts
lines: 1446
reason: the bookings list gains the `unpaid=finished` queue filter (#4264
  review F3), one schema line and one AND-composed fragment beside the
  `additionalOwed` queue it mirrors; the fragment itself lives in
  unpaid-finished-stays.ts, so the list adds a door and not a rule.

file: src/lib/booking-date-modification-service.ts
lines: 2398
reason: the INV-MOD-012 clamp and the $0 auto-settle now reach an approved
  member whole-lodge booking with no Payment row (#4264 review F1), through
  the one predicate `isUnpaidConfirmedWholeLodge`; the conditions widen in
  place beside the PENDING/PAYMENT_PENDING gate they already own, and the
  batch sibling booking-modify-settlement.ts took the same change inside
  its ceiling.
