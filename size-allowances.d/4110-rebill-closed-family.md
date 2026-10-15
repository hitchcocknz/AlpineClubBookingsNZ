# File-size allowances for #4110 (re-bill a closed or voided family) and the #4098 review fixes

file: src/app/api/admin/subscription-billing/route.ts
lines: 362
reason: the panel's read of the charge queue now carries each covered
  member's released marker and subscription status, so Close is offered only
  where the close can succeed. It is the same include on the same query, with
  the two lines saying why; a second query or route for it would split one
  payload the panel reads in one place.

file: src/lib/membership-subscription-billing.ts
lines: 1638
reason: the preview decides which family charges still bill their family: a
  closed charge does until a subscription it covered stops being settled, and a
  partly reversed one raises the officer's warning (owner decisions on #4110).
  That rule reads the family-charge query's own rows and feeds the same
  billedFamilyTypes map and exceptions list the preview loop uses, and the
  confirm keeps the warning out of the persisted exceptions beside where it
  persists them; moving it out would split one preview's decision across two
  files.

file: src/lib/xero-operation-retry.ts
lines: 2025
reason: Xero Operations must explain a stray subscription invoice (raised
  after its charge was closed as paid) with its own reason rather than the
  generic payload-repair text. That is one early branch in the PARTIAL
  dispatch every retry reason comes from, reading the shared predicate and
  message, plus their import.
