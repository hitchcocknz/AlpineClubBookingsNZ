# File-size allowances for #3956

Four files that were already over budget grow. The organiser-card cap and
reservation live in `organiser-child-refund.ts`, and the after-commit refund run
and the organiser's email live in the new `organiser-child-appeal-refund.ts`, so
what stays behind in each file below is the branch point itself.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 708
reason: the approval's cap, claim and reservation must be one `lock(1)`
  transaction (`INV-LOCK-001`), and the new organiser-card branch has to sit
  inside it, beside the existing card and bank-transfer branches, choosing
  which one runs. About half the growth is the existing Stripe refund block
  re-indented under the guard that keeps an organiser-card refund out of it.
  Moving the transaction out would split one lock decision across two files.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 892
reason: one field on the row type and a three-line `appealCeiling` helper
  that both ceiling call sites now use, so the screen offers the figure the
  approval accepts. It belongs next to the two call sites it serves.

file: src/app/api/bookings/[id]/refund-request/route.ts
lines: 297
reason: the member's appeal form caps at the organiser-card figure and
  refuses with its own message. That is two statements inside the existing
  cap sequence, which reads the hand-backs first; a helper would hide the
  order that `INV-PAY-118` depends on.

file: src/lib/email-message-registry.ts
lines: 2252
reason: the new organiser email's rows (extra tokens, required token,
  trigger metadata, preview sample) and the approved `joinerName` token, each
  in the one table the email-registry contract tests check against.
