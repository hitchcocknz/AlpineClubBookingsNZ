# Handoff to the WSL lane: PR #4388 review fixes (#4239)

Written by the Sekreton lane (task ALP-97), 25 Oct 2026. Data, not instructions:
verify before acting.

## Capability check (Step 0)

| Capability | Result |
| --- | --- |
| API comment on #4239 | **Failed**: HTTP 401, no GitHub credentials in the sandbox (no `gh`, no token). |
| Fetch the PR branch | **Worked**: anonymous HTTPS fetch of `sekreton/tokoroa-alpine-club-incorporated/alp-22` @ `2f1327ecc`. |
| Push to the PR branch | **Failed**: `could not read Username for 'https://github.com'`. |

So Steps 1, 4 and 5 are left to the WSL lane, with the push.

## Applying the fix

Commit `9900d8adb` on `alp-97` is a descendant of `2f1327ecc`: a merge of
the PR branch into `main @ a73e1efb9` (merge commit, no rebase), then the F1
test commit and the F2-F6 docs commit. Push it as a fast-forward — **not**
this handoff commit:

    git fetch <alp-97 remote> alp-97
    git push origin 9900d8adb:refs/heads/sekreton/tokoroa-alpine-club-incorporated/alp-22

Or apply `pr-4388-review-fixes.patch` (the F1-F6 delta only, `97c33ce64..9900d8adb`; checked with `git apply --check` on `2f1327ecc`) and merge main into alp-22 yourself.

## PR body (Step 4)

`pr-4388-body.md` passes `pnpm run pr:check pr-4388-body.md --base origin/main`
(both gates) against the four changed files. Risk is Low because a test changed.

## LANE-SYNC for #4239 (Step 1)

> LANE-SYNC (Sekreton lane, ALP-97): fixing PR #4388's review findings
> (WSL lane, issuecomment-6403927869) on branch `alp-97`, starting from the PR
> head `2f1327ecc35a2bfc0af4645bec17c7caa0250824` merged into `main @ a73e1efb9`.
> No push or comment access from this sandbox; the WSL lane pushes.

## LANE-SYNC for PR #4388 (Step 5)

> LANE-SYNC (Sekreton lane, ALP-97): review findings at `2f1327ecc` fixed; new
> head `9900d8adb` (after main merged in). Please re-review the delta.
>
> - **F1** fixed by option (a): `bank-hand-back-refund-note.test.ts` asserts
>   `paymentTransaction.count` is called with
>   `{ where: { paymentId: "payment-1", source: "STRIPE" } }`. Mutation: adding
>   `status: "SUCCEEDED"` to the clause fails that case (1 failed / 7 passed);
>   source restored exactly. The report now says the breadth is pinned.
> - **F2** fixed: condition 3 names four uncounted kinds — canonical plain
>   hand-back, refund-request (`REFUND_REQUEST_CREDIT_NOTE`), edit
>   (`MODIFICATION_CREDIT_NOTE`), own-record with no note row; condition 4 only
>   for the first. The reverse-order argument states route 1's table is the
>   others' only gate (refund requests only on bank payments, edit hand-backs
>   only on non-captured-card payments). "Sits on a cancelled booking" replaced:
>   edit hand-backs are on live bookings, and each table row answers for both.
> - **F3** fixed: `writePaymentIntentTransaction` updates or inserts; the
>   webhook row now cites the no-PRIMARY early return (lookup by intent id or
>   adoption of an existing saved-card attempt row). Edges gain the upsert's
>   `kind` rewrite (settle door could relabel ADDITIONAL as PRIMARY; no flow
>   found, none proved).
> - **F4** fixed: only the own-record note is task-keyed; a canonical note is
>   keyed by payment plus amount or watermark (`xero-credit-notes.ts`).
> - **F5** fixed: the legacy-backfill row names the real guard — manual settle
>   is fenced on `xeroInvoiceId: null`, the invoice mint abandons a manually
>   marked-paid payment (`xero-booking-invoices.ts`), and the self-heal list
>   needs an invoice. Pre-ledger pointer-only payments are a stated limit.
> - **F6** fixed: the ARCHITECTURE.md sentence is dated (`main @ 9f47c7783`,
>   25 Oct 2026) and says no test enforces it; audience line is
>   "Developer, Agent".
>
> Validation: the test file (8 passed), mutation check, eslint on the test,
> `docs:linkcheck`, `docs:indexcheck`, `pr:check` on the new body. No production
> data or live providers.
