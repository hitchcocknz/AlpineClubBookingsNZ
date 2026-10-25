# Can a bank hand-back reach the nightly card self-heal? A trace of #4239's routes

**Audience: developer, future agent.** Issue #4239. Traced 25 October 2026
against `main @ 9f47c7783`. Read-only: no code, payment, Xero or Stripe
behaviour changed.

## The question

Every night the app looks for refunds that have no Xero refund credit note,
and raises the missing card note itself (the "self-heal",
`reconcileCreditBalances` in `src/lib/cron-credit-reconciliation.ts`). A card
note is settled from the Stripe account. If the money actually went back by
bank transfer (a "hand-back"), a card note would book a refund that never left
Stripe. #4022 showed that the self-heal's list (`getRefundsMissingXeroCreditNotes`,
`src/lib/xero-admin-health.ts`) reads only `source: "STRIPE"` payments, and
pinned that filter on real PostgreSQL
(`src/lib/__tests__/self-heal-bank-hand-back-sources.realdb.test.ts`). #4239
asked whether a hand-back can get past the filter anyway, by four routes.

**Answer: no route reproduces.** No app code can put a bank hand-back's cash
into the self-heal's card ask. The repair tool's "queue refund credit note"
action, when no note row exists, raises a correctly worded bank note and never
a card note. The reasons, and the edges that rest on reading code rather than a
running database, follow.

## What the self-heal's card ask is made of

In plain terms: the self-heal asks for the refunded cash that no note covers
yet, minus any bank cash that a hand-back's own note is meant to answer.
Precisely, the ask is `uncoveredCents − paidAnotherWayUncoveredCents` from
`readRefundCreditNoteGap`, where:

- **The cash side** is `resolveRefundNoteEligibleCash` →
  `resolveStripeCashRefundEvidence` (`src/lib/stripe-cash-refund-evidence.ts`).
  It takes one of two paths:
  - *Provider ledger* (the payment has any `PaymentRefund` row): the recorded
    card refunds, plus the bank records `readPaidAnotherWayCash`
    (`src/lib/card-refund-paid-another-way-cash.ts`) counts as noted. A
    hand-back that is none of those records is left out entirely, so it cannot
    make a gap here.
  - *Legacy mirror* (no `PaymentRefund` rows): `refundedAmountCents`, less
    account credit, less un-noted and still-waiting closes. A bank hand-back
    that raised `refundedAmountCents` stays in this figure **unless it is one
    of those records**. This is the only path where bank cash could leak into a
    card ask.
- **Coverage** (`sumCoveredRefundCreditNoteCents`, `src/lib/xero-sync.ts`)
  counts only active `REFUND_CREDIT_NOTE` links, plus rows resolved by hand. A
  PENDING, RUNNING or FAILED note row covers nothing.
- **What is taken off.** A hand-back counts as a record, so its uncovered part
  comes off the ask (`paidAnotherWayUncoveredCents`, #3924's fix), when it is a
  "Paid another way" close, a paid-back card shortfall, a re-confirmed void
  follow-up, or a plain cancellation hand-back **noted on its own record**
  (#4287, `INV-ADDPAY-043`).

So the danger needs all of the following at once:

1. a STRIPE-source payment with an invoice;
2. no `PaymentRefund` rows;
3. a bank hand-back in its `refundedAmountCents` that is **not** an own-record
   bank record, which in practice means a plain cancellation hand-back whose
   note is the payment's canonical one;
4. that canonical note failed, or not yet linked.

## Which hand-backs are noted on their own record

A plain cancellation hand-back decides at completion whether its note is the
payment's canonical one or its own
(`cancellationHandBackNotedOnItsOwnRecord`, `src/lib/bank-hand-back-refund-note.ts`).
It is its own when the payment is `INTERNET_BANKING` and any of these holds:

- the payment already has a canonical note, linked or on its way;
- the payment has **any STRIPE `PaymentTransaction` row, in any status**;
- the payment has any card refund row.

Each clause is pinned by `src/lib/__tests__/bank-hand-back-refund-note.test.ts`.
An own-record hand-back counts in `readPaidAnotherWayCash` whatever the
payment's later source, so it stays safe through a source change. **Condition 3
therefore needs a hand-back completed on a payment that had no STRIPE row at
that moment.**

## Route 1: the payment's source changes later

`Payment.source` follows the newest PRIMARY ledger row
(`reconcilePaymentAggregatesUnderLock`, `src/lib/payment-transactions.ts`;
newest means latest `createdAt`, then `insertionSeq`,
`src/lib/payment-ledger-order.ts`). A row that already exists never becomes
newer: the one intent-row writer (`writePaymentIntentTransaction`) updates an
existing row and never touches `createdAt`. So reaching condition 3 *and then*
becoming STRIPE needs a STRIPE PRIMARY row **created after** the hand-back
completed. The hand-back sits on a **cancelled** booking. Every writer that
can create one:

| Writer | Can it create a newer STRIPE PRIMARY row on that payment? |
| --- | --- |
| Card intent attach (`attachMintedCardIntent`, `src/lib/card-intent-attach.ts`), the path behind `create-payment-intent` and the public payment link | No. Under `lock(1)` it refuses an `INTERNET_BANKING` payment (`switchedToInternetBanking`) and any non-payable booking (`notPayable`). |
| Saved-card charge attempt (`src/lib/saved-card-charge-attempt.ts`), from `confirm-pending-guests`, `charge-saved-method` and the confirm-pending cron | No. It needs a PENDING booking, which has handed nothing back. |
| A late capture on a cancelled booking (`stripe-webhook-service.ts`, the late-capture branch) | No. Its intent's row was written at attach, before the switch or cancel, so this is an update of an older row. |
| The settle door (`settleBookingPaymentInTransaction`, `src/lib/payment-reconciliation.ts`) | Only for a succeeded intent with no ledger row on the payment. The only such intents are ones attach refused, and their client secret is never returned to the member. Unreachable by app flow; see the edges below. |
| Legacy backfill (`legacyBackfillRows`) | Only when `Payment.stripePaymentIntentId` points at an intent with no row. Reconcile nulls that pointer whenever the newest PRIMARY row is `INTERNET_BANKING`, and the IB switch nulls it too. |
| Manual mark-paid, inbound Xero receipts, IB settlement repairs | No. They write `INTERNET_BANKING` rows. |
| Group settlement (`group-settlement.ts`) | Writes the source column of CONFIRMED joiners only, with no ledger row. A cancelled child with a hand-back is never in that set. |

The reverse order also fails: if the STRIPE row came first, condition 3 cannot
hold, because the hand-back completes as an own record. That covers the common
mixed case: a booking whose member started paying by card and was then marked
paid by hand keeps its card row, so a later hand-back on it is noted on its own
record and stays out of every card ask, whatever the source reads afterwards.

**Verdict: does not reproduce.** The #4022 probe's 2,500–5,000c figures needed
a source change that no writer can make on a payment holding a canonical
hand-back.

## Route 2: the hand-back writers #4022 did not trace

| Writer | Payment it lands on | Can it meet the four conditions? |
| --- | --- | --- |
| Plain cancellation hand-back (`booking-cancel.ts`, `CANCELLED_BOOKING_HAND_BACK`, completed by `resolveManualRefundTask`) | The booking's own payment. Raised only on the manual branch (`cancelRefundDisposition`: a manually marked-paid payment, or a joiner whose organiser paid by bank). Both are `INTERNET_BANKING`: manual settle writes that source, and so does the bank group settlement. | No. It is not STRIPE when written. Its note is keyed by task (`handBackTaskId`), and it is an own record whenever the payment holds any STRIPE row. Leaving IB later is route 1. |
| Group organiser hand-back (`group-organiser-hand-back.ts`, raised from `group-cancel.ts`) | No `paymentId`. The refund lands on each joiner's child payment, raised only when the group settlement had no card intent. Those children are `INTERNET_BANKING` and get no per-child invoice (`enqueueChildInvoices: false`). | No. The self-heal's filter excludes them twice: wrong source, and no `xeroInvoiceId`. |
| Late bank cash on a cancelled booking (`xero-inbound/invoice-paid-effects.ts`) | Under the lock, it checks three times that the payment is `INTERNET_BANKING`. A member's money becomes account credit. An organisation's money raises a plain hand-back task on that payment. | No. That hand-back is the first row above. |
| Internet-banking part payment at cancel (`internet-banking-part-payment-at-cancel.ts`) | Both arms are gated on `INTERNET_BANKING`. Recognising the payment books the cash and forces account credit, which the legacy path subtracts. The manual arm raises a review task with no payment and no amount, and settles nothing. | No. |

**Verdict: does not reproduce.** None of these writers is on a STRIPE-source
payment when it writes. The one hand-back that stays in the legacy figure, a
canonical plain hand-back, could reach the card ask only through route 1.

## The repair tool's "queue refund credit note" action

The booking repair tool (`pnpm run xero:booking-repair`) reads the same gap
for every payment source (`xero-booking-repair-load.ts`), and sizes the ask the
same way: `uncoveredCents − paidAnotherWayUncoveredCents`. Its classifier
(`xero-booking-repair-classify.ts`) picks between two actions:

- **The note row exists and is FAILED or PARTIAL.** The row blocks, and the
  tool offers to retry it. The hand-back wrote `refundMethod: "internet-banking"`
  on that row, and a retry keeps it, so the note is settled from the bank
  account. No second note is raised. A row resolved by hand in Xero is reported,
  never re-run.
- **No note row exists.** The tool queues `QUEUE_REFUND_CREDIT_NOTE` with the
  payment and the amount, but no method
  (`enqueueXeroRefundCreditNoteOperation`). At execution the method falls back
  on the payment's source (`resolveRefundNoteMethod`, `src/lib/xero-refund-method.ts`):
  - On an `INTERNET_BANKING` payment that is internet banking, *not recorded*,
    so `resolveRefundSettlement` (`src/lib/xero-invoice-payments.ts`) leaves the
    note **unsettled** for the treasurer to match to the bank line. It is never
    settled from the Stripe account. Reading the source here is the one
    fallback `INV-PAY-101` allows, for a row that carries no method, and the
    same rule leaves a method nobody recorded unsettled.
  - On a STRIPE payment the fallback is card. Bank cash reaches that ask only
    through the same four conditions, so it is not reachable either.

**Verdict:** (a), a correctly worded bank note. When no method was recorded it
is left unsettled by design, never settled as card.

## Edges this trace does not close

These rest on reading the code, not on a running database. They are stated
limits, not defects found:

- **No source guard on two writers.** The settle door and the saved-card
  attempt do not themselves refuse a payment whose newest PRIMARY row is
  `INTERNET_BANKING`. The protection is structural: attach refuses IB, the IB
  switch cancels the card intent first (and refuses one that has gone
  through), and the saved-card path needs a PENDING booking. A leaked client
  secret for an intent attach refused would be the only door to the settle
  path; the trace found no route that returns one to the member.
- **Re-setting the card-intent pointer on an IB payment.** No writer was found
  that sets `stripePaymentIntentId` on a payment whose newest PRIMARY row is
  `INTERNET_BANKING`. Every writer was searched for this, but none was run.
- **Real-PostgreSQL proof.** The issue suggested real-database tests for each
  route. The trace shows the states cannot be built through app code, so a test
  would have to write the rows by hand, which proves only the filter that
  `self-heal-bank-hand-back-sources.realdb.test.ts` already pins. The guard
  that actually closes route 1, the "any STRIPE row" clause, is pinned by
  `bank-hand-back-refund-note.test.ts`. No PostgreSQL was available for this
  trace.

## Related

- [`../xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md) — the refund-note
  pipeline, #3924, #4022, #4287 and #4312.
- [`../invariants/payment-and-settlement.md`](../invariants/payment-and-settlement.md)
  — `INV-PAY-101` (a refund document names its method from the settlement
  decision, never the payment's source) and `INV-PAY-122` (a "Paid another
  way" close records a hand-back and ends the refund).
