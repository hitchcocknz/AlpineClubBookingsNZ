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
