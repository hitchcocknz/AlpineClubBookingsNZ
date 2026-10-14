# File-size allowances for #4110 (re-bill a closed or voided family) and the #4098 review fixes

file: src/app/api/admin/subscription-billing/route.ts
lines: 362
reason: the panel's read of the charge queue now carries each covered
  member's released marker and subscription status, so Close is offered only
  where the close can succeed. It is the same include on the same query, with
  the two lines saying why; a second query or route for it would split one
  payload the panel reads in one place.

file: src/lib/membership-subscription-billing.ts
lines: 1572
reason: the preview's existing-family-charge filter now excludes the shared
  no-invoice statuses instead of VOIDED alone, so a closed family re-bills. The
  growth is the import and the comment naming both releasers beside the filter
  and the coverage read it governs; moving either out would separate the rule
  from the query it shapes.
