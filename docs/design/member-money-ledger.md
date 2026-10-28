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
