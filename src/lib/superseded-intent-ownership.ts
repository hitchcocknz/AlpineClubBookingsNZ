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
 *   admins. So does a capture whose superseded refund succeeded, while an
 *   open failed-later row on that capture owes money back, dead or not
 *   (`supersededRefundsOwedAgain`, #4221).
 *
 * Under (b′) and (c′) a superseded-machinery operation counts as LIVE while it
 * is not SUCCEEDED:
 * PENDING, PROCESSING and FAILED (retrying or exhausted, where the money is
 * still adjudicated to that machinery and admins were alerted). A SUCCEEDED
 * cancel operation either actually cancelled the intent (its transaction is
 * FAILED — never a settled capture) or handed off to a refund operation that
 * is enqueued BEFORE the cancel operation completes; a SUCCEEDED refund
 * operation leaves the transaction REFUNDED, which holds no net cash. So
 * `status != SUCCEEDED` across both types covers the handoff window itself.
 * It does not cover what follows: when Stripe fails a SUCCEEDED refund later,
 * the capture holds net cash again with no live operation of these types, and
 * (b′) and (c′) count it as a settling capture. The Xero reader covers that
 * gap through the failed-later row (#4221); the two readers differ there
 * until #4227.
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type Prisma,
} from "@prisma/client";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import {
  CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX,
  cardRefundFailedLaterRefundId,
} from "@/lib/payment-recovery-keys";
import { exactPrefix } from "@/lib/prisma-exact-prefix";

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

/** A row the Xero reader reads: the superseded machinery's, or an open failed-later row. */
type OwnershipRow = {
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentIntentId: string;
  idempotencyKey: string;
};

/**
 * #4221: the rows `supersededRefundsOwedAgain` reads - every superseded refund
 * operation, whatever its status (a SUCCEEDED one is the refund Stripe can
 * fail later), and every OPEN failed-later row (`card_refund_failed_later_*`,
 * #4104): live, or dead for the treasurer. A SUCCEEDED one was made again or
 * closed as paid another way. Scoped by the caller (a payment here; one intent
 * for guard (c′), #4227).
 */
const SUPERSEDED_REFUND_OWED_AGAIN_WHERE = [
  { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
  {
    idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX),
    status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
  },
] satisfies Prisma.PaymentRecoveryOperationWhereInput[];

/**
 * #4221: every capture whose money is owed back again after its superseded
 * refund: an open failed-later row whose OWN `paymentIntentId` is the capture
 * (the intent Stripe's failed refund named, as `late-capture-paid-another-way`
 * keys it), on a capture a superseded refund operation exists for.
 *
 * It does not ask which refund the row continues. Once a superseded refund on
 * the capture succeeded, any cash the capture holds again came back from a
 * refund Stripe failed later, whichever door sent it, and every such failure
 * raises or re-plans a row that owes it back. While that row is open, the
 * cash is on its way back to the member. Rows carry the failed-later key's
 * own rule (`cardRefundFailedLaterRefundId`, #4146), not just its prefix.
 *
 * Pure over the rows `SUPERSEDED_REFUND_OWED_AGAIN_WHERE` reads, so guards
 * (b′) and (c′) can share it (#4227).
 */
function supersededRefundsOwedAgain(rows: readonly OwnershipRow[]): Set<string> {
  const superseded = new Set(
    rows
      .filter((row) => row.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT)
      .map((row) => row.paymentIntentId),
  );
  return new Set(
    rows
      .filter(
        (row) =>
          row.status !== PaymentRecoveryOperationStatus.SUCCEEDED &&
          cardRefundFailedLaterRefundId(row.idempotencyKey) !== null &&
          superseded.has(row.paymentIntentId),
      )
      .map((row) => row.paymentIntentId),
  );
}

/**
 * The Xero second-instrument conflict's reading (#4177): every intent id on
 * this payment whose captured money a superseded-intent operation still holds
 * for the member - a REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED, a
 * CANCEL_PAYMENT_INTENT still in flight, or (#4221) a capture owed back again
 * after its superseded refund (`supersededRefundsOwedAgain`). See the module
 * comment for why a dead cancel does not count here while it does for (b′); a
 * dead failed-later row counts, since it still owes the member. Read under
 * lock(1).
 */
export async function listSupersededIntentIdsOwningCaptures(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations: OwnershipRow[] = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      OR: [
        ...SUPERSEDED_REFUND_OWED_AGAIN_WHERE,
        {
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE],
        },
      ],
    },
    select: { type: true, status: true, paymentIntentId: true, idempotencyKey: true },
  });
  const owned = supersededRefundsOwedAgain(operations);
  for (const operation of operations) {
    if (cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null) continue;
    if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
      // Only an in-flight cancel is read.
      owned.add(operation.paymentIntentId);
    } else if (
      operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT &&
      operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED
    ) {
      owned.add(operation.paymentIntentId);
    }
  }
  return [...owned];
}
