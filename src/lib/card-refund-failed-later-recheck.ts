import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { alertFailedLaterCardRefunds, failedLaterLastError } from "@/lib/card-refund-failed-later";
import { findPaidAnotherWayCloseThatMayHavePaid } from "@/lib/card-refund-failed-later-paid-another-way";
import logger from "@/lib/logger";
import { CARD_REFUND_OPERATION_WHERE, cardRefundPaymentBeforeFailure, parseRefundAllocationPlan, type CardRefundPlanSlice } from "@/lib/open-card-refund-owed";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { cardRefundFailedLaterRefundId } from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";

/**
 * #4210 round 4 (`INV-PAY-136`, the deploy window): THE RUNNER WEIGHS A
 * FAILED-LATER ROW AN OLDER RELEASE RAISED BEFORE IT SENDS IT.
 *
 * This release's failed-later writer weighs every refund against the "Paid
 * another way" closes before it raises a row, and marks the row it raises
 * (`paidAnotherWayWeighed`). A row an older release raised - while both colours
 * serve - carries no mark, and may owe a refund a close already paid back. So
 * once the runner has claimed such a row, and before it asks Stripe, it asks
 * whether any closed row's "Paid another way" close may have paid the refund
 * back (`findPaidAnotherWayCloseThatMayHavePaid`; every closed card refund row
 * of the payment is a candidate, since the older row kept no sender). If one
 * may have, the row is not sent: it is put back as a dead check for the whole
 * refund (`uncertain`), audited and alerted - never settled, never sent. Any
 * other row costs nothing: the key and the plan are read off the claimed row.
 *
 * LOCKS (`INV-LOCK-001`): none. The decision moves no money, refunded total,
 * booking status or capacity; it reads outside a transaction, and the one
 * write is a compare-and-set on the claim this worker holds (`PROCESSING`,
 * the claim's `processingStartedAt`), with its audit row in the same
 * transaction - the stale-processing reaper is the only other writer of a
 * claimed row, and it compares the same attempt. A close committed after the
 * read is not seen, so the row is sent as before this release: the stated
 * limit, with the older runner itself. A read that fails leaves the claim for
 * the reaper, never a send.
 */
export async function holdFailedLaterRowForCheck(row: PaymentRecoveryOperation): Promise<boolean> {
  const refundId = cardRefundFailedLaterRefundId(row.idempotencyKey);
  const plan = refundId === null ? null : parseRefundAllocationPlan(row.allocationPlan);
  const slice = plan?.[0];
  if (refundId === null || !plan || !slice || slice.paidAnotherWayWeighed || slice.paidAnotherWayCheck) return false;
  if (row.status !== PaymentRecoveryOperationStatus.PROCESSING || row.processingStartedAt === null) return false;
  try {
    return await holdIfAClosePaidIt(row, refundId, plan);
  } catch (err) {
    logger.error({ err, operationId: row.id }, "Could not weigh a failed-later card refund row against Paid-another-way closes; it is left claimed for the reaper, not sent (#4210)");
    return true;
  }
}

async function holdIfAClosePaidIt(row: PaymentRecoveryOperation, refundId: string, plan: CardRefundPlanSlice[]): Promise<boolean> {
  const [payment, rows, refunds] = await Promise.all([
    prisma.payment.findUnique({ where: { id: row.paymentId }, select: { id: true, bookingId: true, status: true, amountCents: true, refundedAmountCents: true } }),
    prisma.paymentRecoveryOperation.findMany({ where: { paymentId: row.paymentId, ...CARD_REFUND_OPERATION_WHERE } }),
    prisma.paymentRefund.findMany({
      where: { paymentId: row.paymentId },
      select: { stripeRefundId: true, paymentTransactionId: true, amountCents: true, status: true, createdAt: true, stripeCreatedAt: true },
    }),
  ]);
  if (!payment) return false;
  const beforeFailure = cardRefundPaymentBeforeFailure({ ...payment, recoveryOperations: rows, refunds }, refundId);
  const maker = plan[0]?.madeByOperationId ?? null;
  const closedIds = rows.filter((each) => each.status === PaymentRecoveryOperationStatus.SUCCEEDED && each.id !== row.id).map((each) => each.id);
  const candidates = maker !== null && closedIds.includes(maker) ? [maker, ...closedIds.filter((id) => id !== maker)] : closedIds;
  const close = await findPaidAnotherWayCloseThatMayHavePaid(prisma, { rows, beforeFailure, refundId, candidates });
  if (!close) return false;

  const { outcome, ...paidAnotherWay } = close;
  const held = await prisma.$transaction(async (tx) => {
    const put = await tx.paymentRecoveryOperation.updateMany({
      where: { id: row.id, status: PaymentRecoveryOperationStatus.PROCESSING, processingStartedAt: row.processingStartedAt },
      data: {
        // Dead by the recovery module's own rule, as the writer raises a check: never claimed again.
        status: PaymentRecoveryOperationStatus.PENDING,
        attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
        processingStartedAt: null,
        nextRetryAt: new Date(),
        allocationPlan: plan.map((each, index) =>
          index === 0 ? { ...each, paidAnotherWayWeighed: true, paidAnotherWayCheck: { closedOperationId: close.operationId, reason: "uncertain" } } : each,
        ) as unknown as Prisma.InputJsonValue,
        lastError: failedLaterLastError(refundId, outcome),
      },
    });
    if (put.count !== 1) return false;
    await createAuditLog(
      {
        action: "booking-payment.card-refund.failed-later-paid-another-way",
        targetId: row.bookingId,
        entityType: "PaymentRefund",
        entityId: refundId,
        category: "payment",
        severity: "important",
        outcome: "failure",
        summary: `A card refund row an earlier release raised for refund ${refundId}, after its card refund was closed "Paid another way", was held for an officer to check instead of being sent again`,
        metadata: { stripeRefundId: refundId, paymentId: row.paymentId, paymentIntentId: row.paymentIntentId, amountCents: row.amountCents, decision: outcome, raisedOperationId: row.id, heldByRunner: true, ...paidAnotherWay },
      },
      tx,
    );
    return true;
  });
  if (!held) return true; // The claim moved under it (the reaper): never sent from here.
  await alertFailedLaterCardRefunds([
    { outcome, operationId: row.id, bookingId: row.bookingId, paymentIntentId: row.paymentIntentId, amountCents: close.checkCents, stripeRefundId: refundId, paidAnotherWay },
  ]);
  return true;
}
