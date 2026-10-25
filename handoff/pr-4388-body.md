## Linked Issue

- Closes or relates to: Closes #4239

## Summary

- A read-only trace of #4239's four routes by which a bank hand-back might reach the nightly Xero card self-heal or the repair tool's refund-note action. Verdict: none reproduces. Recorded in `docs/reviews/2026-10-25-xero-self-heal-bank-hand-back-routes.md`, linked from `docs/xero/ARCHITECTURE.md` and the contributors hub.
- Review fixes (WSL lane LANE-SYNC on this PR, F1-F6): the report's reasons are corrected (uncounted hand-back kinds, the intent-row writer's insert, the webhook's no-PRIMARY guard, canonical note keys, the manual-settle invoice guard, dated ARCHITECTURE.md sentence), and the unit test now pins the breadth of the "any STRIPE row" clause.

## Risk Level

- [ ] Critical
- [ ] High
- [ ] Medium
- [x] Low
- [ ] Informational/docs only

## Changed Areas

- [ ] Booking/capacity
- [ ] Payment/refund/credits
- [ ] Membership/family lifecycle
- [ ] Xero/Stripe/SES/Sentry integration
- [ ] Auth/security/privacy
- [ ] Admin/finance/lodge UI
- [ ] Public UI/UX/accessibility
- [ ] Database schema/migrations
- [ ] Deployment/operations
- [x] Docs/agent workflow only

## Tests Added Or Updated

- `src/lib/__tests__/bank-hand-back-refund-note.test.ts`: asserts `paymentTransaction.count` is called with `{ where: { paymentId: "payment-1", source: "STRIPE" } }`, so narrowing the clause to captured or PRIMARY rows fails (review F1).

## Validation Commands Run

```bash
pnpm exec vitest run src/lib/__tests__/bank-hand-back-refund-note.test.ts   # 8 passed
# mutation: added status: "SUCCEEDED" to the count's where in bank-hand-back-refund-note.ts -> the F2 case fails; source restored exactly (git diff clean)
pnpm exec eslint src/lib/__tests__/bank-hand-back-refund-note.test.ts
pnpm run docs:linkcheck
pnpm run docs:indexcheck
```

## Commands Not Run And Why

- Full unit suite, build, E2E: PR CI owns them. No real-PostgreSQL tests: the trace shows the states cannot be built through app code (see the report's edges).

## Screenshots Or UI Evidence

- N/A

## Security And Privacy Impact

- None. Docs and one unit-test assertion.

## Data Integrity Impact

- None. No runtime code changed.

## Concurrency And Lock Impact

- [x] N/A — no transaction, lifecycle, capacity, settlement, credit, webhook,
      cron, or concurrency-sensitive writer changed.
- Writer class(es), canonical lock key(s), and acquisition order: N/A
- Immutable pre-lock key source and mutable under-lock re-read: N/A
- Status-guarded claim and proof that a lost claim runs no side effect: N/A
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: N/A
- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None

## Single Source Of Truth

- New or moved definitions, and the one module each now lives in: N/A — no constant, helper, type or rule defined; the ARCHITECTURE.md sentence is dated as a traced fact, not a second definition.
- If anything was copied rather than imported, or a guard was added instead of
  making the wrong thing unrepresentable — which structural option was rejected
  and why: N/A

## Payment Or Accounting Impact

- None. The trace is read-only.

## Migration Or Deployment Impact

- None.

## Docs Updated

- `docs/reviews/2026-10-25-xero-self-heal-bank-hand-back-routes.md` (new), `docs/xero/ARCHITECTURE.md`, `docs/contributors/README.md`.

## Changelog Entry

- Fragment added (`changelog.d/<pr-number>-<slug>.md`): none
changelog: none — docs and a unit-test assertion only; no behaviour changed

## Residual Risks

- None. Stated limits are in the report's "Edges this trace does not close": no real PostgreSQL was run, the upsert's `kind` rewrite was not proved either way, and pre-ledger pointer-only payments were not counted (no production data read).

## Manual Checks Required

- None.

## Safety Confirmation

- [x] I did not use production credentials, production databases, production
      backups, live Stripe, live Xero, live SES, live Sentry, or live provider
      webhooks for exploratory validation.
- [x] Merge handling follows the `AGENTS.md` "Completion and Merge" merge gate
      (#3959): any risk level merges once complete, green on its exact head,
      reviewed with the lenses chosen for its risk, and carrying the full
      Ready-to-Merge comment; no owner Approve is needed. An open owner
      decision still waits for the owner. Merge commits only.
