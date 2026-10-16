import "server-only";

import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { capacityRaceShortfallIntentId } from "@/lib/capacity-race-shortfall-task-key";
import { READ_BACK_TIMEOUT_MS } from "@/lib/card-refund-status-sync";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { CAPTURED_TRANSACTION_STATUS_LIST, predatesRefundLedger } from "@/lib/payment-transaction-status";
import {
  compareAndSetRefundedAmount,
  lockPaymentForRefundedTotal,
  reconcilePaymentAggregates,
  refundLedgerStartSeconds,
  sumRecordedRefundsForPayment,
  sumRecordedRefundsForTransaction,
} from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { getPaymentIntent } from "@/lib/stripe";
import { accountCreditDispositionCents } from "@/lib/stripe-cash-refund-evidence";
import { formatCents } from "@/lib/utils";
import { readResolvedRefundCreditNoteCoverage, sumRefundCreditNoteCoverageCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #4154 (`INV-PAY-134`, owner decision on #4154, 15 Oct 2026: "Guarded
 * recalculation"): A CAPACITY RACE'S CARD CHARGE WHOSE REFUNDED TOTAL READS
 * MORE THAN ITS REFUND ROWS, CORRECTED SO ITS HAND-BACK CAN BE RECORDED.
 *
 * The capacity race refunds by card what the charge's ledger row shows
 * refundable. Where that row already read part or all of the charge refunded
 * with no refund behind it (drift), the rest is a task to check; the officer
 * who finds the member really is owed marks it paid back - the app first
 * checks it can record it - and pays straight after it accepts. That must be
 * recordable on the race's own charge, which holds nothing, so the completion
 * first lowers the charge's refunded total to what its refund rows show - and
 * only where nothing else can be in it.
 *
 * Before anything, under the `Payment` row lock every writer of the total
 * takes first (`lockPaymentForRefundedTotal`, taken here as well as by the
 * caller, so the writer never depends on its caller for it):
 *
 * - **One captured charge for the race's intent** (`no-charge`).
 * - **Stripe has refunded no more of it than its recorded refund rows** (#4154
 *   review M1): read before the transaction, with
 *   a bounded timeout and no retries (`readCapacityRaceStripeRefundedForTask`).
 *   A refund made in the Stripe dashboard whose `charge.refunded` has not yet
 *   arrived would otherwise be paid again by bank, and the late webhook capped
 *   away (`capacityRaceStripeAheadMessage`). Stripe unread, it refuses too:
 *   fail closed (`CAPACITY_RACE_STRIPE_UNREADABLE_MESSAGE`).
 *
 * Then, only where the charge holds too little, every condition below must
 * hold, or the completion is refused with the one that blocked it
 * (`CapacityRaceCorrectionBlocked`):
 *
 * 1. **Made after the refund ledger started** (`predatesRefundLedger`):
 *    before it, a card refund folded into the total with no row
 *    (`INV-PAY-103`), so a refund-row sum would under-read it.
 * 2. **No account credit given back from the booking**
 *    (`accountCreditDispositionCents`): a credit settlement is in the total
 *    with no refund row (`applyLocalRefundAllocation`).
 * 3. **No other refund task on the booking or its payment**, whatever its
 *    state: a completed hand-back or "Paid another way" close is in the total
 *    with no refund row, and an open one may yet be.
 * 4. **No Xero refund note beyond the card refunds** (review M2, `noted`): the
 *    nightly self-heal notes a refunded total with no refund rows as a card
 *    refund, so a note covering more of the payment than its recorded refund
 *    rows (`sumRefundCreditNoteCoverageCents`) may already be this money's.
 *    A self-heal note queued but not yet sent is not counted, and need not
 *    be: the completed task is a noted bank-cash record
 *    (`readPaidAnotherWayUncoveredCents`), so that note's send-time cap
 *    (`createXeroCreditNote`) takes it to nothing.
 * 5. **Every refund row on the charge dated after the ledger started**
 *    (an undated one read as before): a pre-ledger refund's row may not have
 *    counted.
 * 6. **It LOWERS the total, never raises it**: the refund rows' sum
 *    (`sumRecordedRefundsForTransaction`, the floor
 *    `recordStripeRefundsAgainstTransaction` keeps) is below it. The write takes
 *    the smaller of the row's total and that sum, on the shared compare-and-set
 *    (`compareAndSetRefundedAmount`), so it cannot raise one even if the row
 *    moved.
 * 7. **The corrected charge then holds the task.**
 *
 * Runs inside the completion's transaction, after the card refund gate
 * (`cardShortfallSettlement`), which refuses while the race's own card refund
 * row, or a card refund on the payment Stripe failed later, is unsettled. No
 * other refund reaches the race's charge meanwhile: the booking is cancelled,
 * so no member cancel or edit refunds it; condition 3 shuts out every hand-back
 * and close; and a refund made in Stripe itself is the M1 check above, while
 * its later recording serialises on the same `Payment` row lock. The payment's
 * figures are re-derived from its charges (`reconcilePaymentAggregates`) and
 * the correction is audited with its before and after, against the booking's
 * owner; a refusal later in the completion rolls all of it back.
 */
export type CapacityRaceCorrectionBlocked =
  | "no-charge"
  | "charge-before-ledger"
  | "account-credit"
  | "other-task"
  | "noted"
  | "pre-ledger-refund"
  | "nothing-to-lower"
  | "still-short";

/** What blocked the correction, as the officer's refusal names it. */
export const CAPACITY_RACE_CORRECTION_BLOCKED_REASON: Record<CapacityRaceCorrectionBlocked, string> = {
  "no-charge": "the payment's records hold no captured charge for the card payment the dates filled up during",
  "charge-before-ledger": "the charge was made before the app kept a record of each card refund",
  "account-credit": "account credit was given back from this booking",
  "other-task": "the booking or its payment has another refund task",
  noted: "a Xero refund credit note already covers more of this payment than its card refunds on record, so one may already have been raised for this money",
  "pre-ledger-refund": "a refund on the charge predates the app's record of each card refund",
  "nothing-to-lower": "the charge's card refunds on record already account for all it reads refunded",
  "still-short": "even corrected, the charge would not hold this amount",
};

/**
 * What a refusal tells the officer to do about Xero (review M2, M4): raise the
 * note by hand only where the booking has an invoice for one to credit, and
 * never a second where a note already covers it.
 */
export type CapacityRaceXero = "invoiced" | "no-invoice" | "noted";

export const CAPACITY_RACE_XERO_SENTENCE: Record<CapacityRaceXero, string> = {
  invoiced: "Then raise its refund credit note in Xero by hand: the app will not raise one.",
  "no-invoice": "The booking has no Xero invoice to credit, so no refund credit note is needed.",
  noted: "A Xero refund credit note on this payment may already cover it: check before raising another.",
};

/**
 * #4154 (`INV-PAY-134`): a capacity race's part to check, when the race's own
 * card charge holds too little for it. The app cannot record a bank refund
 * there, so it says what to do with money the treasurer pays anyway.
 */
export const CAPACITY_RACE_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE =
  "The payment's records show too little of this card charge left to refund, so the app cannot record this as paid back - it may already have gone back. Check Stripe and the bank. If the member has had it, dismiss this task with a note saying how. If it is really owed, refund it by bank transfer and dismiss this task with a note saying when and how much.";

export function capacityRaceNothingToAllocateMessage(xero: CapacityRaceXero): string {
  return `${CAPACITY_RACE_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE} ${CAPACITY_RACE_XERO_SENTENCE[xero]}`;
}

export function capacityRaceCorrectionRefusal(blocked: CapacityRaceCorrectionBlocked, invoiced: boolean): string {
  const xero: CapacityRaceXero = blocked === "noted" ? "noted" : invoiced ? "invoiced" : "no-invoice";
  return `${capacityRaceNothingToAllocateMessage(xero)} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON[blocked]}.)`;
}

/** Stripe's own refunded figure for the race's charge, read before the completion's transaction (review M1). */
export type CapacityRaceStripeRefunded = { readable: true; refundedCents: number } | { readable: false };

export const CAPACITY_RACE_STRIPE_UNREADABLE_MESSAGE =
  "The app could not reach Stripe to check this card charge's refunds, so it cannot record this yet. Try again in a few minutes, and do not pay it until the app accepts.";

export function capacityRaceStripeAheadMessage(stripeCents: number, recordedCents: number, format: ClubFormat): string {
  return `Stripe shows ${formatCents(stripeCents, format)} of this card charge refunded, but the app has recorded only ${formatCents(recordedCents, format)}: a refund made in Stripe may not have reached the app yet. Try again in a few minutes, and do not pay it until the app accepts. If the member was refunded in Stripe, dismiss this task with a note saying how.`;
}

/**
 * Review M1: what Stripe says the race's charge has refunded, for a capacity
 * race's part to check being marked paid back; null for any other task. A
 * provider call, made BEFORE the completion's transaction, bounded as the
 * cron's read-backs are (`READ_BACK_TIMEOUT_MS`, no retries). Unread, it says
 * so, and the completion refuses.
 */
export async function readCapacityRaceStripeRefundedForTask(taskId: string): Promise<CapacityRaceStripeRefunded | null> {
  const head = await prisma.manualRefundTask.findUnique({ where: { id: taskId }, select: { kind: true, occurrenceKey: true, bookingId: true } });
  const paymentIntentId = head ? capacityRaceShortfallIntentId(head) : null;
  if (paymentIntentId === null) return null;
  try {
    const intent = await getPaymentIntent(paymentIntentId, { timeoutMs: READ_BACK_TIMEOUT_MS, expand: ["latest_charge"] });
    const charge = intent.latest_charge;
    if (charge && typeof charge === "object" && Number.isSafeInteger(charge.amount_refunded) && charge.amount_refunded >= 0) {
      return { readable: true, refundedCents: charge.amount_refunded };
    }
    logger.warn({ taskId, paymentIntentId }, "Stripe returned no readable charge for a capacity race's card payment; its hand-back is refused until it can be read (#4154)");
  } catch (error) {
    logger.warn({ taskId, paymentIntentId, err: error }, "Could not read a capacity race's card charge from Stripe; its hand-back is refused until it can be (#4154)");
  }
  return { readable: false };
}

const toSeconds = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * The race's own charge, ready to take `amountCents` - corrected first where
 * it holds too little and every condition holds. Throws the refusal, naming
 * the blocker, otherwise.
 */
export async function capacityRaceChargeForHandBack(
  store: Prisma.TransactionClient,
  params: {
    task: { id: string; bookingId: string; paymentId: string; booking: { memberId: string | null } };
    raceIntentId: string;
    amountCents: number;
    /** Read before the transaction (`readCapacityRaceStripeRefundedForTask`); absent, it is unread. */
    stripe: CapacityRaceStripeRefunded | null;
    /** Whether the booking has a Xero invoice its hand-back's note would credit (`cancelledBookingRefundInvoiceId`). */
    invoiced: boolean;
    /** The officer completing the task. */
    actingMemberId: string | null;
    /** The club's format, for the audit's and the refusal's sentences. */
    format: ClubFormat;
  },
): Promise<{ chargeId: string }> {
  const { task, raceIntentId, amountCents } = params;
  const refuse = (blocked: CapacityRaceCorrectionBlocked) =>
    new ManualBookingPaymentError(capacityRaceCorrectionRefusal(blocked, params.invoiced), 400);

  await lockPaymentForRefundedTotal(store, task.paymentId);
  const charges = await store.paymentTransaction.findMany({
    where: { paymentId: task.paymentId, stripePaymentIntentId: raceIntentId, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
    // Exactly one is taken, or none: ordered only so the ledger's order census (`INV-PAY-133`) reads every capture read alike.
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { id: true, amountCents: true, refundedAmountCents: true, createdAt: true },
  });
  if (charges.length !== 1) throw refuse("no-charge");
  const charge = charges[0]!;
  const recordedCents = await sumRecordedRefundsForTransaction(store, charge.id);
  if (!params.stripe?.readable) throw new ManualBookingPaymentError(CAPACITY_RACE_STRIPE_UNREADABLE_MESSAGE, 409);
  if (params.stripe.refundedCents > recordedCents) {
    throw new ManualBookingPaymentError(capacityRaceStripeAheadMessage(params.stripe.refundedCents, recordedCents, params.format), 409);
  }
  if (charge.amountCents - charge.refundedAmountCents >= amountCents) return { chargeId: charge.id };

  const ledgerStart = await refundLedgerStartSeconds(store);
  if (predatesRefundLedger(toSeconds(charge.createdAt), ledgerStart, "pre-ledger")) throw refuse("charge-before-ledger");
  if ((await accountCreditDispositionCents(store, task.bookingId)) > 0) throw refuse("account-credit");
  const otherTasks = await store.manualRefundTask.count({
    where: { id: { not: task.id }, OR: [{ bookingId: task.bookingId }, { paymentId: task.paymentId }] },
  });
  if (otherTasks > 0) throw refuse("other-task");
  const resolvedNotes = await readResolvedRefundCreditNoteCoverage(task.paymentId, store);
  if (
    resolvedNotes.unreadableOperationIds.length > 0 ||
    (await sumRefundCreditNoteCoverageCents(task.paymentId, resolvedNotes, store)) > (await sumRecordedRefundsForPayment(store, task.paymentId))
  ) {
    throw refuse("noted");
  }
  const refunds = await store.paymentRefund.findMany({ where: { paymentTransactionId: charge.id }, select: { stripeCreatedAt: true } });
  if (refunds.some((refund) => predatesRefundLedger(refund.stripeCreatedAt && toSeconds(refund.stripeCreatedAt), ledgerStart, "pre-ledger"))) {
    throw refuse("pre-ledger-refund");
  }
  if (recordedCents >= charge.refundedAmountCents) throw refuse("nothing-to-lower");
  if (charge.amountCents - recordedCents < amountCents) throw refuse("still-short");

  // Never a raise, even against a row that moved: the smaller of the two.
  const { previousCents, nextCents } = await compareAndSetRefundedAmount(
    store,
    charge.id,
    (row) => Math.min(row.refundedAmountCents, recordedCents),
    { writeStatus: true },
  );
  await reconcilePaymentAggregates({ paymentId: task.paymentId, store });
  await createAuditLog(
    {
      action: "booking-payment.capacity-race.refunded-total-corrected",
      memberId: params.actingMemberId,
      actorMemberId: params.actingMemberId,
      subjectMemberId: bookingOwner(task.booking).memberId,
      targetId: task.bookingId,
      entityType: "PaymentTransaction",
      entityId: charge.id,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: `Capacity race card charge's refunded total corrected from ${formatCents(previousCents, params.format)} to ${formatCents(nextCents, params.format)}, the card refunds on record, so its hand-back can be recorded (#4154)`,
      metadata: {
        bookingId: task.bookingId,
        paymentId: task.paymentId,
        paymentTransactionId: charge.id,
        paymentIntentId: raceIntentId,
        manualRefundTaskId: task.id,
        refundedBeforeCents: previousCents,
        refundedAfterCents: nextCents,
        recordedCardRefundCents: recordedCents,
      },
    },
    store,
  );
  // Re-checked on what was written: the task is placed on this charge alone.
  if (charge.amountCents - nextCents < amountCents) throw refuse("still-short");
  return { chargeId: charge.id };
}

