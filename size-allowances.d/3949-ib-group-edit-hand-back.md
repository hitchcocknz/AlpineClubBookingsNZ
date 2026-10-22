# File-size allowances for #3949

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 731
reason: the approval names who its bank-transfer part goes back to - the
  group organiser on a joiner the organiser paid for by internet banking - for
  the hand-back it raises and the email it sends, from the one predicate in
  `group-organiser-paid.ts`; the one line is that predicate's import, and the
  approval that raises the task and sends the email is the only place both
  facts meet.

file: src/lib/email/booking.ts
lines: 1806
reason: the "Booking Modified" sender's `refundByBankTransfer` parameter now
  says who the bank transfer goes to (the member, or the group organiser) rather
  than only whether there is one; the one line is the payee type's import,
  beside the parameter it types, which every edit door's call is checked against.

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2367
reason: the finance queue tells the officer the money goes to the group
  organiser on a joiner the organiser paid for by internet banking - the
  paid-back dialog's title and sentence, the dismissal's sentence and the
  queue's intro paragraph for those rows; each sits beside every other kind's
  title, sentence and intro in this same render, so the new ones have to sit
  with them.

file: src/lib/booking-cancel.ts
lines: 2851
reason: the paid-cancel gate and the cancel's capture evidence each learn that
  an Internet Banking organiser child's settle mirror is the capture (the one
  predicate lives in `group-organiser-paid.ts`), beside the card twin's line
  in the same gate; without it a joiner's cancel flipped the organiser's share
  FAILED. And (owner decision, 22 Oct 2026) the joiner's own cancel of such a
  place forces the organiser-by-hand method beside the card twin's forcing, and
  its hand-back's email, confirmation and alert name the organiser - each
  beside the cash hand-back's own lines in the same branch.
