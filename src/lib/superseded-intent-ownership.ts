/**
 * WHICH CARD CAPTURES THE SUPERSEDED-INTENT MACHINERY OWNS (#1992, #4177).
 *
 * The superseded-intent machinery (booking-payment-cleanup queues a
 * CANCEL_PAYMENT_INTENT recovery operation; when the cancel loses to a late
 * capture, payment-recovery's handoff marks that transaction SUCCEEDED and
 * queues a REFUND_SUPERSEDED_PAYMENT operation for the cron) transiently
 * produces a SUCCEEDED PRIMARY Stripe capture with net cash that no settlement
 * ever passed through. Its money is already spoken for — the recovery cron
 * will refund it under its `payment_recovery_refund_<txn>_<pi>` key — so it is
 * never "the capture that settled the booking":
 *
 * - the duplicate-capture refund (`markBookingPaymentSucceeded`, guards b′ and
 *   c′) would otherwise refund the REAL settlement as the duplicate and, once
 *   the cron also refunds the superseded capture, leave the booking PAID at
 *   zero net cash;
 * - the Xero second-instrument conflict (`findSecondInstrumentSettlement`),
 *   on a PAID / COMPLETED booking, would otherwise name a capture that is
 *   going back to the member, where the duplicate-capture refund names the
 *   real settlement (#4177). Never on a CANCELLED booking: there the new bank
 *   cash has nowhere to go, so every capture still counts.
 *
 * One home for the operation types and the refund's liveness. The two readers
 * fail safe in opposite directions, so they read a CANCEL_PAYMENT_INTENT
 * operation differently:
 *
 * - guards (b′) and (c′) (`listLiveSupersededIntentIds`,
 *   `findLiveSupersededIntentOperation`) treat any operation not SUCCEEDED as
 *   live. Wrongly skipping a capture there costs nothing; wrongly counting one
 *   refunds the real settlement;
 * - the Xero conflict (`listSupersededIntentIdsOwningCaptures`) counts a cancel
 *   operation only while it is in flight
 *   (`PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`). A dead cancel with no
 *   refund operation behind it has handed the money to nobody, and wrongly
 *   skipping that capture would hide a booking paid twice. A refund operation
 *   still counts until it SUCCEEDED, dead or not: its machinery alerted the
 *   admins.
 *
 * Under (b′) and (c′) a superseded-machinery operation counts as LIVE while it
 * is not SUCCEEDED:
 * PENDING, PROCESSING and FAILED (retrying or exhausted, where the money is
 * still adjudicated to that machinery and admins were alerted). A SUCCEEDED
 * cancel operation either actually cancelled the intent (its transaction is
 * FAILED — never a settled capture) or handed off to a refund operation that
 * is enqueued BEFORE the cancel operation completes; a SUCCEEDED refund
 * operation leaves the transaction REFUNDED, which holds no net cash. So
 * `status != SUCCEEDED` across both types covers the whole handoff window with
 * no gap.
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type Prisma,
} from "@prisma/client";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";

export const SUPERSEDED_INTENT_OPERATION_TYPES = [
  PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
  PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
] as const;

type RecoveryOperationReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation">;

/** The one liveness predicate both reads below share. */
function liveSupersededOperation() {
  return {
    type: { in: [...SUPERSEDED_INTENT_OPERATION_TYPES] },
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  } satisfies Prisma.PaymentRecoveryOperationWhereInput;
}

/**
 * Guard (b′): every intent id on this payment whose money a live
 * superseded-intent recovery operation already owns. Read under lock(1), which
 * every caller already holds.
 */
export async function listLiveSupersededIntentIds(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: { paymentId, ...liveSupersededOperation() },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}

/**
 * Guard (c′), belt-and-braces sibling of (b′) with a deliberately DIFFERENT
 * query shape (direct intent-id lookup, not scoped to a payment): does a live
 * superseded-intent recovery operation own this specific intent's money? The
 * duplicate-capture refund re-checks its matched "settlement" with it, so even
 * a candidate that slipped the (b′) exclusion leaves the arriving capture
 * plain `already_paid`.
 */
export async function findLiveSupersededIntentOperation(
  tx: RecoveryOperationReader,
  paymentIntentId: string
) {
  return tx.paymentRecoveryOperation.findFirst({
    where: { paymentIntentId, ...liveSupersededOperation() },
    select: { id: true },
  });
}

/**
 * The Xero second-instrument conflict's reading (#4177): every intent id on
 * this payment whose captured money a superseded-intent operation still holds
 * for the member - a REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED, or a
 * CANCEL_PAYMENT_INTENT still in flight. See the module comment for why a dead
 * cancel does not count here while it does for (b′). Read under lock(1).
 */
export async function listSupersededIntentIdsOwningCaptures(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      OR: [
        {
          type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT,
          status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
        },
        {
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE],
        },
      ],
    },
    select: { paymentIntentId: true },
  });
  return [...new Set(operations.map((operation) => operation.paymentIntentId))];
}
