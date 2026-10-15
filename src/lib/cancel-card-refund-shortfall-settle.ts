import "server-only";

import { ManualRefundTaskStatus, PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { capacityRaceShortfallIntentId } from "@/lib/capacity-race-shortfall-task-key";
import { cancelCardShortfallOccurrenceKey, cancelCardShortfallPart } from "@/lib/manual-refund-task-settlement-rules";
import { isPaymentRecoveryOperationExhausted, isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { buildBookingCancellationRefundIdempotencyKey, buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking, CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } from "@/lib/payment-recovery-keys";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { isStripeTransaction, lockPaymentForRefundedTotal } from "@/lib/payment-transactions";

/**
 * #4097 (`INV-PAY-129`, coordinator decisions on PR #4122): HOW A CANCEL'S CARD
 * REFUND SHORTFALL IS MARKED PAID BACK.
 *
 * - **Its money settles on the payment's non-card charges first**
 *   (`preferTransactionIds`), as a "Paid another way" close places it on the
 *   charges its card refund was for - the bank part was sized from exactly
 *   their headroom, so its allocation can succeed.
 * - **Never while the card part is still being refunded.** Under the `Payment`
 *   row lock (`lockPaymentForRefundedTotal`, which every refunded-total writer
 *   takes first), a completion is refused while the cancel's card refund
 *   recovery (`booking_cancel_refund_recovery_<bookingId>`, or a capacity
 *   race's per intent, #4154) is not SUCCEEDED:
 *   the card's slices and this hand-back must never be read off one ledger
 *   while one of them is still moving. Nor (#4104) while a card refund on the
 *   payment that Stripe failed later is owed again by a row of its own. The refusal names the next step by the
 *   row's state - running, failed and waiting to retry, or stopped (close it
 *   as Paid another way) - on the recovery module's own rules.
 * - **A part to check waits for its bank-transfer sibling**, which was sized on
 *   the same non-card charges: completed first, the check part would use that
 *   money and leave the bank part told to dismiss. Once the bank part is
 *   closed, a check part settles only on whatever headroom is left.
 * - **A refusal names the dismiss route** where the payment's records hold
 *   nothing for it (`cardShortfallSettlementRefusal`).
 *
 * Asked by `chooseEditReviewSettlementRoute` before the status claim, inside the
 * completion's transaction, so a refusal leaves the task OPEN.
 */
/** The card refund recovery is running, or queued to run. */
export const CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE =
  "The card part of this cancellation's refund is still being refunded; mark this once it settles.";

/** The card refund failed and its runner will try again. */
export const CARD_SHORTFALL_CARD_AWAITING_RETRY_MESSAGE =
  "The card part of this cancellation's refund failed and is waiting to retry: wait for its retry to go through, then mark this. If its retries run out, close it as Paid another way on the Stuck States page first.";

/** The card refund's retries are spent (`deadCardRefundOperationWhere`'s rule). */
export const CARD_SHORTFALL_CARD_STOPPED_MESSAGE =
  "The card part of this cancellation's refund has stopped retrying: close it as Paid another way on the Stuck States page (once the member has had that money back another way), then mark this.";

/** A part to check, while its sibling bank-transfer part is still open. */
export const CARD_SHORTFALL_BANK_PART_FIRST_MESSAGE =
  "Mark the bank-transfer part of this cancellation's refund first: it is settled on the money this part would otherwise use. Then mark this, if the check shows it is really owed.";

export const CARD_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE =
  "The payment's records show nothing left to refund for this - it may already have gone back. Check Stripe and the bank: if the member has been refunded, dismiss this task with a note saying how.";

/**
 * #4154 (`INV-PAY-133`): a capacity race's part to check, when the race's own
 * card charge holds nothing for it. The app cannot record a bank refund there,
 * so it says what to do with money the treasurer pays anyway.
 */
export const CAPACITY_RACE_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE =
  "The payment's records show none of this card charge left to refund, so the app cannot record this as paid back - it may already have gone back. Check Stripe and the bank. If the member has had it, dismiss this task with a note saying how. If it is really owed, refund it by bank transfer, dismiss this task with a note saying when and how much, and raise its refund credit note in Xero by hand: the app will not raise one.";

/**
 * The payment's captured charges the card refund cannot carry, newest first:
 * every captured charge that is not a Stripe one (`isStripeTransaction`, the
 * rule the card refund plan itself uses - its complement, so the two cannot
 * disagree about a charge). What a bank-transfer part is sized on and settles on.
 */
export async function nonCardCapturedCharges(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<Array<{ id: string; headroomCents: number }>> {
  const rows = await db.paymentTransaction.findMany({
    where: { paymentId, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
  });
  return nonCardChargeHeadroom(rows ?? []);
}

/** The pure step of `nonCardCapturedCharges`, for rows already captured: #4119's cancel preview reads its in-memory ledger through it. */
export function nonCardChargeHeadroom(
  capturedRows: ReadonlyArray<Parameters<typeof isStripeTransaction>[0] & { id: string; amountCents: number; refundedAmountCents: number }>,
): Array<{ id: string; headroomCents: number }> {
  return capturedRows
    .filter((row) => !isStripeTransaction(row))
    .map((row) => ({ id: row.id, headroomCents: Math.max(0, row.amountCents - row.refundedAmountCents) }));
}

/** Why the card refund recovery is not settled, as the refusal says it - or null when it is (or there is none). */
function cardRefundRefusal(cardRefund: { status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null; lastError: string | null } | null): string | null {
  if (!cardRefund || cardRefund.status === PaymentRecoveryOperationStatus.SUCCEEDED) return null;
  if (isPaymentRecoveryOperationExhausted(cardRefund)) return CARD_SHORTFALL_CARD_STOPPED_MESSAGE;
  // A raw-string READ: the enum member stays in the recovery module (INV-PAY-056's census).
  if (cardRefund.status === "FAILED" || (cardRefund.status === PaymentRecoveryOperationStatus.PENDING && cardRefund.lastError)) {
    return isPaymentRecoveryOperationInFlight(cardRefund) ? CARD_SHORTFALL_CARD_AWAITING_RETRY_MESSAGE : CARD_SHORTFALL_CARD_STOPPED_MESSAGE;
  }
  return CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE;
}

/** Null for any other task; for a shortfall, its settlement's preferred charges, or the refusal. */
export async function cardShortfallSettlement(
  task: { kind: string | null; occurrenceKey: string | null; bookingId: string; paymentId: string | null },
  store: Prisma.TransactionClient,
): Promise<{ preferTransactionIds: string[]; onlyTransactionIds?: string[]; nothingToAllocateMessage?: string } | null> {
  const part = cancelCardShortfallPart(task);
  if (part === null || task.paymentId === null) return null;
  await lockPaymentForRefundedTotal(store, task.paymentId);
  // #4104 review (MM3): the cancel's own recovery row, and any card refund on
  // this payment Stripe failed later and that is owed again by a row of its own
  // (`card_refund_failed_later_<refund>`) - card money still moving either way.
  // #4154: a capacity race's cancel's own rows are one per intent, on its booking.
  // TODO(#4153, #4158): one spelling - `bookingCancelCardRefundRecoveryWhere`, through `exactPrefix`.
  const cardRefunds = await store.paymentRecoveryOperation.findMany({
    where: {
      OR: [
        { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(task.bookingId) },
        { bookingId: task.bookingId, idempotencyKey: { startsWith: buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(task.bookingId) } },
        { paymentId: task.paymentId, idempotencyKey: { startsWith: CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { status: true, attempts: true, nextRetryAt: true, lastError: true },
  });
  const refusal = (cardRefunds ?? []).map(cardRefundRefusal).find((message) => message !== null);
  if (refusal) throw new ManualBookingPaymentError(refusal, 409);
  // #4154 (`INV-PAY-133`, PR #4159 review F2/F4): a capacity race's settles on
  // the race's own card charge and nowhere else - never a non-card charge, nor
  // a charge captured later on the same payment. Short there, the allocation
  // refuses (`onlyTransactionIds`) with the race's own way out.
  const raceIntentId = capacityRaceShortfallIntentId(task);
  if (raceIntentId !== null) {
    const own = await store.paymentTransaction.findMany({
      where: { paymentId: task.paymentId, stripePaymentIntentId: raceIntentId, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
      select: { id: true },
    });
    const ids = (own ?? []).map((row) => row.id);
    return { preferTransactionIds: ids, onlyTransactionIds: ids, nothingToAllocateMessage: CAPACITY_RACE_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE };
  }
  // A part to check settles only on what the bank-transfer part leaves (coordinator, PR #4122).
  if (part === "check") {
    const bank = await store.manualRefundTask.findUnique({
      where: { occurrenceKey: cancelCardShortfallOccurrenceKey(task.bookingId, "bank") },
      select: { status: true },
    });
    if (bank?.status === ManualRefundTaskStatus.OPEN) throw new ManualBookingPaymentError(CARD_SHORTFALL_BANK_PART_FIRST_MESSAGE, 409);
  }
  return { preferTransactionIds: (await nonCardCapturedCharges(store, task.paymentId)).map((row) => row.id) };
}
