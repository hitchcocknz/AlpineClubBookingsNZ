import "server-only";

import type { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { CAPTURED_TRANSACTION_STATUS_LIST, EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { compareAndSetRefundedAmount, reconcilePaymentAggregates, refundLedgerStartSeconds } from "@/lib/payment-transactions";
import { accountCreditDispositionCents } from "@/lib/stripe-cash-refund-evidence";

/**
 * #4154 (`INV-PAY-133`, owner decision on #4154, 15 Oct 2026: "Guarded
 * recalculation"): A CAPACITY RACE'S CARD CHARGE WHOSE REFUNDED TOTAL READS
 * MORE THAN ITS REFUND ROWS, CORRECTED SO ITS HAND-BACK CAN BE RECORDED.
 *
 * The capacity race refunds by card what the charge's ledger row shows
 * refundable. Where that row already read part or all of the charge refunded
 * with no refund behind it (drift), the rest is a task to check; the officer
 * who finds the member really is owed pays it by bank transfer, and marking the
 * task paid back must be able to record that on the race's own charge. That
 * charge holds nothing, so the completion first lowers the charge's refunded
 * total to what its refund rows show - and only where nothing else can be in
 * it. Every condition below must hold, or the completion is refused with the
 * one that blocked it (`CapacityRaceCorrectionBlocked`):
 *
 * 1. **One captured charge for the race's intent.**
 * 2. **Made after the refund ledger started** (`refundLedgerStartSeconds`):
 *    before it, a card refund folded into the total with no row
 *    (`INV-PAY-103`), so a refund-row sum would under-read it.
 * 3. **No account credit given back from the booking**
 *    (`accountCreditDispositionCents`): a credit settlement is in the total
 *    with no refund row (`applyLocalRefundAllocation`).
 * 4. **No other refund task on the booking or its payment**, whatever its
 *    state: a completed hand-back or "Paid another way" close is in the total
 *    with no refund row, and an open one may yet be.
 * 5. **Every refund row on the charge dated after the ledger started**: a
 *    pre-ledger refund's row may not have counted.
 * 6. **It LOWERS the total, never raises it**: the refund rows' sum (recorded,
 *    non-refused - `EXCLUDED_LEDGER_REFUND_STATUSES`, the floor
 *    `recordStripeRefundsAgainstTransaction` keeps) is below it. The write takes
 *    the smaller of the row's total and that sum, on the shared compare-and-set
 *    (`compareAndSetRefundedAmount`), so it cannot raise one even if the row
 *    moved.
 * 7. **The corrected charge then holds the task.**
 *
 * Runs inside the completion's transaction, under the `Payment` row lock its
 * caller took first (`lockPaymentForRefundedTotal`, which every writer of the
 * total takes), after the card refund gate: never while a card refund on the
 * payment is still moving. The payment's figures are re-derived from its
 * charges (`reconcilePaymentAggregates`) and the correction is audited with its
 * before and after; a refusal later in the completion rolls all of it back.
 */
export type CapacityRaceCorrectionBlocked =
  | "no-charge"
  | "charge-before-ledger"
  | "account-credit"
  | "other-task"
  | "pre-ledger-refund"
  | "nothing-to-lower"
  | "still-short";

/** What blocked the correction, as the officer's refusal names it. */
export const CAPACITY_RACE_CORRECTION_BLOCKED_REASON: Record<CapacityRaceCorrectionBlocked, string> = {
  "no-charge": "the payment's records hold no captured charge for the card payment the dates filled up during",
  "charge-before-ledger": "the charge was made before the app kept a record of each card refund",
  "account-credit": "account credit was given back from this booking",
  "other-task": "the booking or its payment has another refund task",
  "pre-ledger-refund": "a refund on the charge predates the app's record of each card refund",
  "nothing-to-lower": "the charge's card refunds on record already account for all it reads refunded",
  "still-short": "even corrected, the charge would not hold this amount",
};

export function capacityRaceCorrectionRefusal(nothingToAllocateMessage: string, blocked: CapacityRaceCorrectionBlocked): string {
  return `${nothingToAllocateMessage} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON[blocked]}.)`;
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
    task: { id: string; bookingId: string; paymentId: string };
    raceIntentId: string;
    amountCents: number;
    /** The officer completing the task; null only on a read-only preview, which rolls back. */
    actingMemberId: string | null;
    nothingToAllocateMessage: string;
  },
): Promise<{ chargeId: string }> {
  const { task, raceIntentId, amountCents } = params;
  const refuse = (blocked: CapacityRaceCorrectionBlocked) =>
    new ManualBookingPaymentError(capacityRaceCorrectionRefusal(params.nothingToAllocateMessage, blocked), 400);

  const charges = await store.paymentTransaction.findMany({
    where: { paymentId: task.paymentId, stripePaymentIntentId: raceIntentId, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
    select: { id: true, amountCents: true, refundedAmountCents: true, createdAt: true },
  });
  if (charges.length !== 1) throw refuse("no-charge");
  const charge = charges[0]!;
  if (charge.amountCents - charge.refundedAmountCents >= amountCents) return { chargeId: charge.id };

  const ledgerStart = await refundLedgerStartSeconds(store);
  if (ledgerStart !== null && toSeconds(charge.createdAt) < ledgerStart) throw refuse("charge-before-ledger");
  if ((await accountCreditDispositionCents(store, task.bookingId)) > 0) throw refuse("account-credit");
  const otherTasks = await store.manualRefundTask.count({
    where: { id: { not: task.id }, OR: [{ bookingId: task.bookingId }, { paymentId: task.paymentId }] },
  });
  if (otherTasks > 0) throw refuse("other-task");
  const refunds = await store.paymentRefund.findMany({
    where: { paymentTransactionId: charge.id },
    select: { amountCents: true, status: true, stripeCreatedAt: true },
  });
  // An undated row is read as the earliest: only a refund the ledger saw made counts as one.
  if (refunds.some((refund) => refund.stripeCreatedAt === null || (ledgerStart !== null && toSeconds(refund.stripeCreatedAt) < ledgerStart))) {
    throw refuse("pre-ledger-refund");
  }
  const excluded: readonly string[] = EXCLUDED_LEDGER_REFUND_STATUSES;
  const recordedCents = refunds.filter((refund) => !excluded.includes(refund.status)).reduce((sum, refund) => sum + refund.amountCents, 0);
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
      targetId: task.bookingId,
      entityType: "PaymentTransaction",
      entityId: charge.id,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: `Capacity race card charge's refunded total corrected from ${previousCents} to ${nextCents} cents, the card refunds on record, so its hand-back can be recorded (#4154)`,
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
