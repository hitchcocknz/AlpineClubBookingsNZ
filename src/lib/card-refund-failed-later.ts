/**
 * #4104 (`INV-PAY-128`): A CARD REFUND STRIPE ACCEPTED AND FAILED LATER IS OWED
 * AGAIN.
 *
 * Stripe can answer a refund `pending` and fail it days later (a closed card, an
 * issuer's refusal). A `pending` refund counts as made (`isRecordedRefundStatus`),
 * so the door that asked for it - a cancellation, an edit, an approved refund
 * request, the recovery runner - closed its debt or wrote none, and when the
 * refund failed only the payment's refunded total fell back. Nothing owed it.
 *
 * WHO SEES IT. The one writer of a transaction's refund rows
 * (`recordStripeRefundsAgainstTransaction`) is the only place a refund is seen
 * to have failed after it counted (`recordStripeRefundLedgerEntry`'s
 * `failedLater`): its own guarded counted -> refused write, or a caller told the
 * refund counts (a replayed key reads Stripe's original `pending` back) while
 * the row already says it failed. Whoever sees it - the refund-failed webhook,
 * a `charge.refunded` sync, the payments cron's read-back, the runner's replay -
 * keeps it owed here, in the same transaction, under the Payment row lock that
 * writer already holds.
 *
 * HOW IT IS OWED. A refund the club made for this booking (its Stripe metadata
 * names the booking; a refund made by hand in the Stripe dashboard does not, and
 * is the treasurer's own):
 *
 * - **Marked made on an open row** (`madeRefundId`, #4083): that row is re-planned,
 *   the slice unmarked and moved to its next key, so the runner sends it again
 *   and "Refunds owed" counts it once. A row a worker holds (`PROCESSING`) is
 *   not touched: the caller fails and retries (`FailedLaterRefundHeldError`).
 * - **Otherwise** a new refund row, one per failed Stripe refund
 *   (`card_refund_failed_later_<refund>`), for exactly that refund's amount on
 *   its own charge. Its key is new, so its retry is a request Stripe has never
 *   seen, and a second observer writes nothing. A closed row is never reopened:
 *   nothing links its other slices to the refunds that made them, and replaying
 *   one past Stripe's 24-hour key window would refund it twice.
 * - **A retry that failed later too** is raised with its attempts spent - dead,
 *   for the treasurer's "Paid another way" (#3372) - so a card that keeps taking
 *   refunds and failing them is not asked for ever.
 *
 * The officers are alerted once, by the writer that raised or re-planned the
 * row, after its commit (`alertFailedLaterCardRefunds`).
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type Prisma,
} from "@prisma/client";

import logger from "@/lib/logger";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  buildCardRefundFailedLaterRecoveryKey,
  CARD_REFUND_FAILED_LATER_REASON,
  nextRefusedRefundKeySuffix,
} from "@/lib/payment-recovery-keys";
import { stripeReferenceId, type StripeReference } from "@/lib/stripe-references";
import { formatCents } from "@/lib/utils";

/** The refund as the ledger writer has it: Stripe's object, or the slice of it the writer reads. */
export type FailedLaterRefundInput = {
  id: string;
  amount: number;
  status?: string | null;
  metadata?: Record<string, string> | null;
};

/** A row raised or re-planned for a refund that failed later, for the alert after commit. */
export type FailedLaterCardRefundDebt = {
  outcome: "raised" | "raised-dead" | "re-planned";
  operationId: string;
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  stripeRefundId: string;
};

/** A worker holds the row that marks this refund made; the caller fails and is retried. */
export class FailedLaterRefundHeldError extends Error {
  constructor(stripeRefundId: string, operationId: string) {
    super(
      `Card refund ${stripeRefundId} failed after Stripe accepted it, and recovery ${operationId} is mid-attempt; try again once it finishes (#4104)`,
    );
    this.name = "FailedLaterRefundHeldError";
  }
}

/** What the row says, for a person reading it; nothing parses it. */
function failedLaterLastError(refundId: string, dead: boolean): string {
  return dead
    ? `Stripe accepted retried refund ${refundId} and later reported it failed too. Not asked for again automatically: pay the member another way and close it (#4104).`
    : `Stripe accepted refund ${refundId} and later reported it failed, so no money went back. It is owed again and is asked for again as a new request (#4104).`;
}

/**
 * Keep one failed-later refund owed. Runs inside the ledger writer's
 * transaction, after its refund rows and mirror, under its Payment row lock.
 * Returns the row it raised or re-planned; null when the refund is not the
 * club's to re-send, or another writer already raised it.
 */
export async function keepFailedLaterCardRefundOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    refund,
    paymentIntentId,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    refund: FailedLaterRefundInput;
    /** The refund's intent, where the writer has it; else the charge's own. */
    paymentIntentId: string | null;
  },
): Promise<FailedLaterCardRefundDebt | null> {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
  if (!payment) return null;
  const intentId =
    paymentIntentId ??
    (await tx.paymentTransaction.findUnique({ where: { id: paymentTransactionId }, select: { stripePaymentIntentId: true } }))
      ?.stripePaymentIntentId ??
    null;
  if (!intentId) {
    logger.error({ stripeRefundId: refund.id, paymentTransactionId }, "A card refund that failed later names no card payment to refund again (#4104)");
    return null;
  }
  if (refund.metadata?.bookingId !== payment.bookingId) {
    // A dashboard refund, or one for another booking: not the club's to re-send.
    logger.warn(
      { stripeRefundId: refund.id, paymentId },
      "A card refund Stripe accepted then failed names no booking of this payment; it is not owed again automatically (#4104)",
    );
    return null;
  }

  const open = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
    },
    select: { id: true, status: true, allocationPlan: true, bookingId: true, paymentIntentId: true },
  });
  for (const row of open) {
    const plan = parseRefundAllocationPlan(row.allocationPlan);
    if (!plan?.some((slice) => slice.madeRefundId === refund.id)) continue;
    if (row.status === PaymentRecoveryOperationStatus.PROCESSING) {
      throw new FailedLaterRefundHeldError(refund.id, row.id);
    }
    const replanned = plan.map((slice) =>
      slice.madeRefundId === refund.id
        ? { paymentTransactionId: slice.paymentTransactionId, amountCents: slice.amountCents, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) }
        : slice,
    );
    // Compare-and-set on the plan read: a write in between (a cancellation's
    // re-plan, a claim) means this read is stale, and the caller retries.
    const moved = await tx.paymentRecoveryOperation.updateMany({
      where: { id: row.id, status: row.status, allocationPlan: { equals: row.allocationPlan as Prisma.InputJsonValue } },
      data: { allocationPlan: replanned as unknown as Prisma.InputJsonValue, lastError: failedLaterLastError(refund.id, false) },
    });
    if (moved.count !== 1) throw new FailedLaterRefundHeldError(refund.id, row.id);
    return {
      outcome: "re-planned",
      operationId: row.id,
      bookingId: row.bookingId,
      paymentIntentId: row.paymentIntentId,
      amountCents: refund.amount,
      stripeRefundId: refund.id,
    };
  }

  const dead = refund.metadata?.reason === CARD_REFUND_FAILED_LATER_REASON;
  const idempotencyKey = buildCardRefundFailedLaterRecoveryKey(refund.id);
  const inserted = await tx.paymentRecoveryOperation.createMany({
    data: [
      {
        type: PaymentRecoveryOperationType.REFUND_BOOKING_MODIFICATION,
        status: PaymentRecoveryOperationStatus.PENDING,
        bookingId: payment.bookingId,
        paymentId,
        paymentIntentId: intentId,
        amountCents: refund.amount,
        idempotencyKey,
        stripeKeyPrefix: idempotencyKey,
        allocationPlan: [{ paymentTransactionId, amountCents: refund.amount }] as unknown as Prisma.InputJsonValue,
        // Dead by the recovery module's own rule (attempts spent): never
        // claimed, and closable as paid another way. Not a FAILED write, which
        // has one route (`INV-PAY-056`).
        attempts: dead ? MAX_PAYMENT_RECOVERY_ATTEMPTS : 0,
        nextRetryAt: new Date(),
        lastError: failedLaterLastError(refund.id, dead),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count !== 1) return null;
  const row = await tx.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
  return {
    outcome: dead ? "raised-dead" : "raised",
    operationId: row.id,
    bookingId: payment.bookingId,
    paymentIntentId: intentId,
    amountCents: refund.amount,
    stripeRefundId: refund.id,
  };
}

/** Each refund the ledger writer saw fail later, kept owed in its transaction, in the order it saw them. */
export async function keepFailedLaterCardRefundsOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    refunds,
    fallbackPaymentIntentId,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    refunds: ReadonlyArray<FailedLaterRefundInput & { payment_intent?: StripeReference }>;
    fallbackPaymentIntentId?: string | null;
  },
): Promise<FailedLaterCardRefundDebt[]> {
  const debts: FailedLaterCardRefundDebt[] = [];
  for (const refund of refunds) {
    const paymentIntentId = stripeReferenceId(refund.payment_intent) ?? fallbackPaymentIntentId ?? null;
    const debt = await keepFailedLaterCardRefundOwed(tx, { paymentId, paymentTransactionId, refund, paymentIntentId });
    if (debt) debts.push(debt);
  }
  return debts;
}

/**
 * The officers' alert, once per row raised or re-planned, after the commit
 * that wrote it. Never throws: the debt is already owed.
 */
export async function alertFailedLaterCardRefunds(debts: ReadonlyArray<FailedLaterCardRefundDebt>): Promise<void> {
  if (debts.length === 0) return;
  try {
    const [{ clubFormatValues }, { alertPaymentRecoveryOfficers }] = await Promise.all([
      import("@/lib/club-format-server"),
      import("@/lib/payment-recovery-alert"),
    ]);
    const format = await clubFormatValues();
    for (const debt of debts) {
      const amount = formatCents(debt.amountCents, format);
      await alertPaymentRecoveryOfficers(
        {
          bookingId: debt.bookingId,
          operationId: debt.operationId,
          amountCents: debt.amountCents,
          paymentIntentId: debt.paymentIntentId,
          errorMessage:
            debt.outcome === "raised-dead"
              ? `Stripe accepted a retried card refund of ${amount} and later reported it failed too, so no money went back. It is still owed and will not be asked for again automatically: pay the member another way and close it under Refunds owed.`
              : `Stripe accepted a card refund of ${amount} and later reported it failed, so no money went back. It is owed again and will be asked for again automatically.`,
        },
        format,
      ).catch((err: unknown) =>
        logger.error({ err, operationId: debt.operationId }, "Could not alert the officers to a card refund that failed later (#4104)"),
      );
    }
  } catch (err) {
    logger.error({ err }, "Could not alert the officers to card refunds that failed later (#4104)");
  }
}
