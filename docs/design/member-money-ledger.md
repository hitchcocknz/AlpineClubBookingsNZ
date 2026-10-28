# Member money ledger — design

Audience: Developer, Agent. The opening section also explains the proposal for
an operator. Canonical home: [contributor documentation](../contributors/README.md).

## 1. Purpose, authority and scope

Members should have one explainable answer to what they owe and what the club
owes them. This design for [#4461](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461)
extends the [booking ledger](booking-ledger.md) into a balanced journal for all
member money. It changes no code, schema, migration, money policy or deployed
behaviour. Implementation children below are proposals for owner approval;
none is filed by this document.

The settled contract is all member money, optional Xero, two-way sync, and the
ledger switch before individual mirror-drift fixes. Sources are the owner
records on [#4450](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4450)
and [#4461's bank-transfer decision](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4461#issuecomment-6415213385).
Without Xero, the app shows configured club bank details and a unique payment
reference; a finance officer records the receipt. With Xero connected, its
receipt can enter through the same journal command. Bank reconciliation,
sending accounting statements and invoices, GST returns, expenses, payroll and
profit-and-loss stay in Xero. The app still supplies its booking confirmations,
payment instructions and member money views.

This extends #3527/#3532; it does not discard their posted history. The 27 Oct
scope decision supersedes D-3532-4's bookings-only limit, while subscription
charge snapshots remain immutable (`INV-MONEY-008`). D-3532-1's whole-history
proof, D-3532-2's eventual column removal and D-3532-3's charge descriptions
remain. The [#3584 blueprint](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584#issuecomment-5985615635)
remains the reader contract: reversible surface changes, unchanged template
pins, instrument-sourced payable asks, preserved history anchors, officer-only
verdicts and explicit approval for changed figures. Recommendations in its
question list are not decisions. Its latest recorded production proof is still
[gate closed](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584#issuecomment-6405174317);
this design neither opens that gate nor authorises production access.

The alternatives already rejected on #4461 remain rejected: making Xero
read-only would prevent the treasurer's chosen workflow; building a full
accounting package would exceed the scope. Another set of guarded totals would
retain the drift. Instead each economic event posts once, corrections reverse
and re-post, and both systems render or ingest those identified facts.

The design preserves the exact refund-answer and failed-refund decisions on
[#4361](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4361#issuecomment-6390676570)
and its [coding, locked-period and void decisions](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4361#issuecomment-6391255474).
It also preserves [#4219's outside-spend and automatic-email decisions](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4219#issuecomment-6265621107).
No cancellation tier, fee exemption, credit election, refund entitlement or
collection policy changes here. Genuine choices appear in section 10.

## 2. Accounts and settings

The books balance even when no accounting provider is connected. Internal
account identities are stable enums; Xero codes are deployment settings, never
identities or hard-coded club policy. Dr increases assets/expenses; Cr increases
liabilities/revenue. A correction swaps the original entry's debits and credits.

| Internal account | Normal side and purpose | Xero mapping in settings |
| --- | --- | --- |
| `MEMBER_RECEIVABLE` | Dr; charges less settlements, per debtor and obligation | Proposed `memberReceivable`: Xero system receivables control, implemented through invoices/allocations rather than a direct journal to a system account |
| `STRIPE_CLEARING` | Dr; gross captures less refunds, fees and payouts | Existing `stripeBankAccount` (BANK); do not substitute the club bank account |
| `BANK` | Dr; member receipts and completed bank hand-backs, per configured bank | Proposed `memberReceiptsBankAccount` (BANK); reuse `bankTransferRefundAccount` for outbound bank refunds when configured |
| `CASH` | Dr; officer-evidenced cash receipts | Proposed `memberCashAccount` (ASSET); explicit clearing/cash account |
| `MEMBER_CREDIT` | Cr; spendable liability, per member, funding lot and origin | Proposed `memberCreditLiability` (LIABILITY); Xero adapter uses credit notes and allocations with a documented control-account bridge |
| `REFUND_PAYABLE` | Cr; club owes an exact refund obligation, not yet paid | Proposed `memberRefundPayable` (LIABILITY); outstanding refund documents/bridge, never a bank payment without evidence |
| `BOOKING_REVENUE` | Cr; sold guest-nights, with lodge and rate dimensions | Existing `hutFeesIncome`; negative booking adjustments use `hutFeeRefunds` and the same economic category |
| `SUBSCRIPTION_REVENUE` | Cr; immutable subscription components | Existing `subscriptionIncome`, with the charge's frozen per-component overrides |
| `JOINING_FEE_REVENUE` | Cr; type-driven joining fees | Proposed `joiningFeeIncome` (REVENUE); preserve existing joining-fee item account resolution |
| `FEE_REVENUE` | Cr; change, cancellation and other configured member fees, separately categorised | Proposed `memberFeesIncome` (REVENUE), registered fallback to `hutFeesIncome` for existing booking fees |
| `GST_PAYABLE` | Cr; tax component, reversed with its original charge | Proposed `memberGstPayable`: Xero system tax control via tax-coded documents, not a direct system-account write |
| `STRIPE_FEES` | Dr; actual provider fee, never netted from a member receipt | Existing `stripeFees` (EXPENSE); pending mapping holds export, not local capture posting |
| `GOODWILL` | Dr; approved discretionary credit/write-off | Existing `goodwillWriteOffs`, including its registered `hutFeeRefunds` fallback |
| `EXTERNAL_CONTROL` | Either; explained member-credit use on Xero-only business outside the app | Proposed `memberExternalControl` (configured clearing account); imported source references make each amount accountable without importing general accounting |
| `OPENING_CONTROL` | Either; evidenced historical opening amounts where full reconstruction is unavailable | Proposed `memberOpeningControl` (clearing/equity account chosen by Finance); never used to plug an unexplained difference |

Mapping means the adapter can explain how an internal account reaches Xero,
not that every internal leg becomes a Xero manual-journal line. Xero owns its
receivables and tax control accounts. Credit notes can affect Xero receivables
where the app carries a credit liability: the adapter's control bridge must
prove equality of the combined member position, and must not create both a
credit note and another credit for the same liability. System-account mappings
are validated against the provider's chart; user-selectable mappings enforce
account class/type. An item must resolve to the frozen account and tax treatment
or export conflicts visibly. No guessed account code is sent.

Extend the existing registry in `src/lib/xero-account-mapping-keys.ts`; its
settings, resolver, API, defaults and warnings stay one source (`INV-SSOT-001`,
`INV-INT-021`). New keys above are proposals, not implemented settings. With
Xero disabled no code mapping is required. Connecting it later validates the
mappings and creates an export baseline; existing invoices and notes are adopted
by exact identity and coverage before any missing document is rendered. History
already in Xero is never invoiced again. An unset new mapping leaves affected
exports visibly pending; the existing bank-refund unset behaviour remains an
unsettled note, never a payment from Stripe. A mapping change affects future
render plans; replay uses its frozen mapping version.

Tax is recorded in integer cents with the charge: gross = net + tax, and
reversal uses those exact cents, tax code and coding version. Use the existing
money boundary helpers (`INV-MONEY-001`, `INV-MONEY-003`); do not calculate tax
with new floating-point arithmetic. Preserve current inclusive tax treatment
and subscription component rounding. Section 10 asks how the journal's tax and
recognition settings should cover clubs with different accounting policies.

## 3. Journal model and enforcement

A posted event is an indivisible, balanced batch. The following are proposed
records and constraints, not a Prisma schema to apply in this documentation PR.

| Record | Contract |
| --- | --- |
| `MemberMoneyEvent` | Immutable kind enum, origin enum, source identity/version, deterministic event key, payload hash, actor, reason, effective instant/date and recording time; links a journal batch, including explicit zero-money events |
| `MemberMoneyJournal` | One immutable header per event/batch, currency, policy/coding version, expected line count and optional unique reversal target; no editable draft or balance column |
| `MemberMoneyLine` | Header, account enum, Dr/Cr enum, positive integer cents, member/debtor, obligation, booking/lodge where applicable, credit lot, charge/refund identity, original posting reference, tax and frozen descriptive evidence |
| `MemberMoneyObligation` | Exact charge/refund identity and source, immutable face terms; settlements and reductions refer to it explicitly; remaining amount is derived |
| `MemberMoneyApplication` | Immutable attribution of a receipt/refund/credit to an obligation, amount, and optional unique reversal target; no timing/amount heuristic |
| `MemberMoneySourceLink` | Durable link from existing booking line, credit row, subscription component, capture, refund or Xero fact to the event; unique per source fact, not per coincident amount |
| Inbox, object head and export manifest | Mutable delivery/workflow records with enum statuses and guarded claims; contain no authoritative money balance |

One batch can have several obligations and members, as for a group receipt, but
its debits equal its credits **per currency**. Currency is the club's configured
currency, not an FX feature. Cross-currency provider facts conflict; no silent
conversion. Member-credit transfers cannot change the debtor implicitly. A group
records one cash receipt and exact applications to child obligations; it never
records that full receipt on each child. Family subscription coverage similarly
names one debtor and several covered members, not several copies of revenue.

`BookingLedgerLine` remains the booking event evidence and compatibility view.
Existing line ids, reversal chains, posting keys, night prices, names and
`BookingModification.priceLines` survive. A bridge maps every existing line to
its journal event and legs; new booking commands create both representations in
one transaction until booking readers move. Do not independently reprice either
side or double-post cash because both a booking line and a refund row name it.
The existing booking balance helper becomes a projection of these same economic
facts; the bridge proves its charge/settlement/adjustment signs agree. Once
there are no old readers or writers, compatibility posting can retire; posted
legacy lines remain retained evidence.

### Database refusal and mandatory posting

A failed posting rolls back the business event as well. Extend #4453's
least-privilege provisioning to every new immutable money table: the application
has INSERT/SELECT only, no UPDATE, DELETE, TRUNCATE, ownership, role escalation,
mutable view or privileged routine escape. Migration and operator roles remain
separate; the audit-retention connection gains no money-table rights. Verify
the effective grants at rollout: #4453 is opt-in, so merely merging its code is
not proof a deployment uses the restricted role.

Use CHECKs for positive integer cents and valid line shape, enum domains,
unique event/source/reversal keys, and deferred constraint triggers for
cross-row balance. A journal header records its creating transaction identity;
line inserts must belong to that same transaction. A later INSERT into an old
batch is refused, closing the hole that INSERT-only grants alone leave open.
At commit, every header must have its declared complete line set, balanced
accounts, valid tax split and consistent currency. A non-zero event has at least
two legs; an explicit zero event has no legs. Partial batches cannot commit.
An exact reversal copies all original legs with Dr/Cr swapped, references that
batch uniquely, and cannot be reversed twice; a new correction event follows.

During expansion legacy source records may lack links. For each migrated
writer cohort, durable source events require a non-null journal reference and
a deferred database check verifies the event kind and amount against its
complete batch. Mandatory links become universal after backfill and old-worker
drain; do not claim a nullable FK enforces universal posting. A durable refund
request before a provider call is an obligation/reservation, not a cash refund.
The later accepted cash fact, application, reversal if failed, compatibility
projection and outbox insert commit together. No caller may catch a refused
posting and commit its business mutation anyway.

On a replay, reserve the deterministic event key with conflict-do-nothing, read
the winner and require identical canonical payload/hash and source links. An
identical replay returns that complete batch. A reused key with different cents
or coding is a conflict, not a successful skip. No per-line skipping can leave
half a journal. Event keys include source event/attempt identity and revision;
they never use wall-clock arrival time, equal amounts or array position.

Foreign keys from posted records use RESTRICT for financial parents and stable
identities, without update cascades or set-null rewrites. #4453 protects booking
and lodge ids but [#4482](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/4482)
shows parent DELETE can still erase legacy booking lines. Section 10 proposes
archiving financial parents and RESTRICT for that existing cascade too. Until
that decision is approved and delivered, append-only enforcement is incomplete
and the ledger cut-over remains blocked. Personal-data erasure must use the
retention design; it cannot erase economic postings by deleting their parent.

### Module boundary and transactions

Callers express a business event through a small public API. Proposed
`src/lib/member-money/index.ts` exposes typed commands, read projections and
transaction participants; `internal/` owns posting, key construction, account
rules, source linkage and stores. Provider adapters call commands with evidence,
never Prisma money delegates. Pure planning/ownership modules import no database
or provider client. Routes, cron and admin code cannot import internal stores.

An error-level import rule allows money-writer Prisma access only inside this
boundary and refuses deep imports, re-export bypasses, dynamic imports and raw
SQL escapes elsewhere. Existing writers are named, temporary migration
exceptions removed cohort by cohort. Shared Prisma transaction access is not
itself a capability boundary: restricted delegates/typed participants keep money
tables out of caller clients, and an AST census covers delegate and SQL writes.
Tests exercise the real import rule with prohibited examples and mutation probes;
the database balance/refusal tests cover what lint cannot prove (`INV-SSOT-004`).

Use the existing lock classification, never a new generic journal advisory key.
Settlement/lifecycle commands take global `lock(1)` under `INV-LOCK-001`; capacity
composition adds sorted lodge keys from `acquireLodgeCapacityLock`, then member
keys. Credit-only adjustments keep the member-credit tier; #4219 applied-credit
release takes global then member, while free-lot #4270 mirroring takes member
only. `INV-LOCK-002` fixes order and key minting; `INV-LOCK-003` requires registry
updates. Re-read mutable inputs after locks and win a status/version-guarded
claim before side effects. Provider calls stay outside the transaction.

For new inbound settlement and export-result recording, use one order: applicable
advisory tiers, mutable business/payment rows, object-head rows in sorted order,
then export/link rows. Do not lock immutable lines (`SELECT FOR UPDATE` requires
UPDATE privilege). Credit-only object processing never later escalates to a
global-key command: defer it and restart with the required tiers. The inbound
void and outbound completion both use this order, replacing the legacy
link-first/Payment-first inversion. Old writers must drain before the new order
is enabled. Each writer child reconciles open PRs and the last ten merged PRs
for its subsystem, registers participants, and proves its races on PostgreSQL;
this documentation PR introduces no transaction or lock site.
