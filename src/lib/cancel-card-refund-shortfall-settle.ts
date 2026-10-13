import "server-only";

import { PaymentRecoveryOperationStatus, PaymentSource, type Prisma } from "@prisma/client";

import { isCancelCardShortfallTask } from "@/lib/manual-refund-task-settlement-rules";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";

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
 *   recovery (`booking_cancel_refund_recovery_<bookingId>`) is not SUCCEEDED:
 *   the card's slices and this hand-back must never be read off one ledger
 *   while one of them is still moving.
 * - **A refusal names the dismiss route** where the payment's records hold
 *   nothing for it (`cardShortfallSettlementRefusal`).
 *
 * Asked by `chooseEditReviewSettlementRoute` before the status claim, inside the
 * completion's transaction, so a refusal leaves the task OPEN.
 */
export const CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE =
  "The card part of this cancellation's refund is still being refunded; mark this once it settles.";

export const CARD_SHORTFALL_NOTHING_TO_ALLOCATE_MESSAGE =
  "The payment's records show nothing left to refund for this - it may already have gone back. Check Stripe and the bank: if the member has been refunded, dismiss this task with a note saying how.";

/** The payment's captured charges that did not come through Stripe, newest first: what a bank-transfer part settles on. */
export async function nonCardCapturedCharges(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<Array<{ id: string; headroomCents: number }>> {
  const rows = await db.paymentTransaction.findMany({
    where: { paymentId, source: { not: PaymentSource.STRIPE }, status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, amountCents: true, refundedAmountCents: true },
  });
  return (rows ?? []).map((row) => ({ id: row.id, headroomCents: Math.max(0, row.amountCents - row.refundedAmountCents) }));
}

/** Null for any other task; for a shortfall, its settlement's preferred charges, or the refusal. */
export async function cardShortfallSettlement(
  task: { kind: string | null; occurrenceKey: string | null; bookingId: string; paymentId: string | null },
  store: Prisma.TransactionClient,
): Promise<{ preferTransactionIds: string[] } | null> {
  if (!isCancelCardShortfallTask(task) || task.paymentId === null) return null;
  await lockPaymentForRefundedTotal(store, task.paymentId);
  const cardRefund = await store.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(task.bookingId) },
    select: { status: true },
  });
  if (cardRefund && cardRefund.status !== PaymentRecoveryOperationStatus.SUCCEEDED) {
    throw new ManualBookingPaymentError(CARD_SHORTFALL_CARD_STILL_REFUNDING_MESSAGE, 409);
  }
  return { preferTransactionIds: (await nonCardCapturedCharges(store, task.paymentId)).map((row) => row.id) };
}
