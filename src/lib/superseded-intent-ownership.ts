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
 *   admins. So does a refund it made that Stripe failed later, while the
 *   failed-later row that asks for it again is open, dead or not
 *   (`supersededRefundContinuedBy`, #4221).
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
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
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

/** A row the Xero reader reads: the superseded machinery's, or a failed-later row. */
type OwnershipRow = {
  id: string;
  type: PaymentRecoveryOperationType;
  status: PaymentRecoveryOperationStatus;
  paymentIntentId: string;
  paymentTransactionId: string | null;
  idempotencyKey: string;
  allocationPlan: Prisma.JsonValue;
};

/**
 * #4221: the superseded refund a failed-later row (`card_refund_failed_later_*`,
 * #4104) asks for again, or undefined when it continues another door's refund.
 * Stripe accepted the superseded refund, so its operation SUCCEEDED, and later
 * failed it; the failed-later row owes it again on the same charge.
 *
 * - **Who made it, where the writer recorded it** (`madeByOperationId`, #4166):
 *   a superseded refund operation, or an earlier failed-later row whose own
 *   retry failed too (followed back to the refund that began the chain). Any
 *   other recorded maker is another door's refund: not continued.
 * - **Where no maker is recorded** (a row raised before #4166, or one whose
 *   refund several rows could have sent: two superseded refunds on a booking
 *   send the same metadata): the superseded refund operation on the
 *   transaction the row's slice refunds. The writer records the slice on the
 *   transaction the refund was made against, and a superseded refund operation
 *   names the one transaction it refunds, so this holds where metadata cannot
 *   tell two such refunds apart.
 *
 * Doubt counts the capture (undefined), as this reader did before #4221:
 * wrongly skipping a capture could hide a booking paid twice.
 */
function supersededRefundContinuedBy(
  row: OwnershipRow,
  rows: ReadonlyMap<string, OwnershipRow>,
  seen: Set<string> = new Set(),
): OwnershipRow | undefined {
  const slice = parseRefundAllocationPlan(row.allocationPlan)?.[0];
  if (!slice || seen.has(row.id)) return undefined;
  seen.add(row.id);
  const maker = slice.madeByOperationId;
  if (typeof maker === "string") {
    const made = rows.get(maker);
    if (made?.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT) return made;
    return made && cardRefundFailedLaterRefundId(made.idempotencyKey) !== null
      ? supersededRefundContinuedBy(made, rows, seen)
      : undefined;
  }
  return [...rows.values()].find(
    (each) =>
      each.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT &&
      each.paymentTransactionId === slice.paymentTransactionId,
  );
}

/**
 * The Xero second-instrument conflict's reading (#4177): every intent id on
 * this payment whose captured money a superseded-intent operation still holds
 * for the member - a REFUND_SUPERSEDED_PAYMENT not yet SUCCEEDED, a
 * CANCEL_PAYMENT_INTENT still in flight, or (#4221) an open failed-later row
 * asking again for a superseded refund Stripe failed later
 * (`supersededRefundContinuedBy`). See the module comment for why a dead
 * cancel does not count here while it does for (b′); a dead failed-later row
 * counts, since it still owes the member. Read under lock(1).
 */
export async function listSupersededIntentIdsOwningCaptures(
  tx: RecoveryOperationReader,
  paymentId: string
): Promise<string[]> {
  const operations: OwnershipRow[] = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      OR: [
        // Every status: a SUCCEEDED one is what a failed-later row continues.
        { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT },
        {
          type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT,
          AND: [PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE],
        },
        // Every status: a closed one may sit inside a chain of retries.
        { idempotencyKey: exactPrefix(CARD_REFUND_FAILED_LATER_RECOVERY_PREFIX) },
      ],
    },
    select: {
      id: true,
      type: true,
      status: true,
      paymentIntentId: true,
      paymentTransactionId: true,
      idempotencyKey: true,
      allocationPlan: true,
    },
  });
  const rows = new Map(operations.map((operation) => [operation.id, operation]));
  const owned = new Set<string>();
  for (const operation of operations) {
    const open = operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED;
    if (cardRefundFailedLaterRefundId(operation.idempotencyKey) !== null) {
      const continued = open ? supersededRefundContinuedBy(operation, rows) : undefined;
      if (continued) owned.add(continued.paymentIntentId);
    } else if (operation.type === PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT) {
      if (open) owned.add(operation.paymentIntentId);
    } else if (operation.type === PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT) {
      // Only an in-flight cancel is read.
      owned.add(operation.paymentIntentId);
    }
  }
  return [...owned];
}
