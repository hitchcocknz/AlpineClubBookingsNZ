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
 * to fail after it counted (`recordStripeRefundLedgerEntry`'s `failedLater`):
 * its own guarded counted -> refused write (`transition`), or a caller told the
 * refund counts - a replayed key reads Stripe's original `pending` back - while
 * the row already says refused (`replayed`). Whoever sees it - the refund-failed
 * webhook, a `charge.refunded` sync, the payments cron's read-back, a door or
 * the runner replaying its key - decides here, in the same transaction, under
 * the Payment row lock that writer already holds.
 *
 * WHICH ROW OWES IT. One row, never two:
 *
 * - **Already owed**: a row of its own (`card_refund_failed_later_<refund>`), or
 *   an open row whose slice it already moved (`failedRefundIds`): nothing.
 * - **An open row that counted it as made** - the slice marked with it
 *   (`madeRefundId`), or the unmarked slice the owed figure fills with it
 *   (`cardRefundSliceFilledBy`, read as the payment stood before the failure):
 *   that slice is moved to its next key and records the failure
 *   (`failedRefundIds`), so the runner sends it again and "Refunds owed" counts
 *   it once. A row someone may be writing - a worker's attempt (`PROCESSING`),
 *   or one no worker has claimed yet (a door's inline attempt may still be
 *   closing or re-planning it) - is not touched: a `transition` fails and is
 *   retried (`FailedLaterRefundHeldError`); a `replayed` refund is read back to
 *   its caller as refused, since the caller is that row's door or worker and
 *   moves it itself (`INV-PAY-128`'s refusal path).
 * - **Otherwise** a new row, for exactly that refund's amount on its own charge,
 *   under a key Stripe has never seen. A closed row is never reopened: nothing
 *   ties its other slices to the refunds that made them.
 *
 * NEVER RE-SENT AUTOMATICALLY, raised dead (attempts spent) for the treasurer's
 * "Paid another way" (#3372) and alerted: a retry that failed later too (a card
 * that keeps taking refunds and failing them), and a refund Stripe created
 * before this install could notice such failures
 * (`CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION`) - the treasurer may already have
 * paid it back by hand. Not owed at all, only alerted: a refund whose Stripe
 * metadata names no booking of this payment (made by hand in the Stripe
 * dashboard, or a legacy group refund).
 *
 * The officers are alerted once per decision, after the commit that made it
 * (`alertFailedLaterCardRefunds`).
 */
import {
  PaymentRecoveryOperationStatus,
  PaymentRecoveryOperationType,
  type PaymentRecoveryOperation,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";

import logger from "@/lib/logger";
import {
  CARD_REFUND_OPERATION_WHERE,
  cardRefundSliceFilledBy,
  parseRefundAllocationPlan,
} from "@/lib/open-card-refund-owed";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import {
  buildCardRefundFailedLaterRecoveryKey,
  CARD_REFUND_FAILED_LATER_REASON,
  nextRefusedRefundKeySuffix,
} from "@/lib/payment-recovery-keys";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { stripeReferenceId, type StripeReference } from "@/lib/stripe-references";
import { formatCents } from "@/lib/utils";

/**
 * The cutoff (#4104 review, ops 8): the migration that shipped this release.
 * A refund Stripe created before it finished on this install failed while
 * nothing here could notice, and the treasurer may have paid it back by hand
 * since, so it is raised dead, never re-sent. It changes no schema.
 */
export const CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

/** The refund as the ledger writer has it: Stripe's object, or the part of it the writer reads. */
export type FailedLaterRefundInput = {
  id: string;
  amount: number;
  status?: string | null;
  created?: number | null;
  metadata?: Record<string, string> | null;
  payment_intent?: StripeReference;
};

/** How the ledger writer saw it fail (see the module comment). */
export type FailedLaterKind = "transition" | "replayed";

/** A decision about one failed-later refund, for the alert after commit. */
export type FailedLaterCardRefundDebt = {
  /**
   * `raised-dead`: a retry that failed too; `raised-backlog`: made before the
   * cutoff; `re-planned-dead`: moved on a row whose retries are already spent;
   * `not-resent`: not the club's refund for this booking - nothing is owed here.
   */
  outcome: "raised" | "raised-dead" | "raised-backlog" | "re-planned" | "re-planned-dead" | "not-resent";
  operationId: string | null;
  bookingId: string;
  paymentIntentId: string | null;
  amountCents: number;
  stripeRefundId: string;
};

/** What the ledger writer does next: the decisions to alert, and the refunds its caller must read as refused. */
export type FailedLaterDecisions = { debts: FailedLaterCardRefundDebt[]; readAsRefused: string[] };

/** A row someone may be writing owns this refund; the caller rolls back and is retried. */
export class FailedLaterRefundHeldError extends Error {
  constructor(stripeRefundId: string, operationId: string) {
    super(
      `Card refund ${stripeRefundId} failed after Stripe accepted it, and recovery ${operationId} is mid-attempt or not yet claimed; try again once it is (#4104)`,
    );
    this.name = "FailedLaterRefundHeldError";
  }
}

/** The recovery module's dead: never claimed again (`deadCardRefundOperationWhere`, `unfinishedCardRefundDebts`). */
function isDeadRow(row: Pick<PaymentRecoveryOperation, "attempts" | "nextRetryAt">): boolean {
  return row.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS || row.nextRetryAt === null;
}

/** What the row says, for a person reading it; nothing parses it. */
function failedLaterLastError(refundId: string, outcome: FailedLaterCardRefundDebt["outcome"]): string {
  if (outcome === "raised-dead") {
    return `Stripe accepted retried refund ${refundId} and later reported it failed too. Not asked for again automatically: pay the member another way and close it (#4104).`;
  }
  if (outcome === "raised-backlog") {
    return `Stripe reported refund ${refundId} failed; it was made before this release could notice that, so it is not asked for again automatically. Check whether the member was paid back, then close it (#4104).`;
  }
  return `Stripe accepted refund ${refundId} and later reported it failed, so no money went back. It is owed again and is asked for again as a new request (#4104).`;
}

const CUTOFF_PRESENT_ROW = z.object({ present: z.boolean() });
const CUTOFF_ROW = z.object({ finished_at: z.date() });

/**
 * When the cutoff migration finished on this install, in whole seconds (Stripe
 * dates a refund in seconds); null where there is no migration history (a
 * `prisma db push` database never ran an older release).
 */
export async function cardRefundFailedLaterCutoffSeconds(db: Prisma.TransactionClient): Promise<number | null> {
  const presence = decodeRawRows(
    await db.$queryRaw`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS "present"`,
    CUTOFF_PRESENT_ROW,
    "card refund failed-later cutoff history present",
  );
  if (!presence[0]?.present) return null;
  const rows = await db.$queryRaw`
    SELECT "finished_at" FROM "_prisma_migrations"
    WHERE "migration_name" = ${CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION}
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
    ORDER BY "finished_at" ASC
    LIMIT 1
  `;
  const [row] = decodeRawRows(rows, CUTOFF_ROW, "card refund failed-later cutoff");
  return row ? Math.floor(row.finished_at.getTime() / 1000) : null;
}

type OpenOwner = { row: PaymentRecoveryOperation; sliceIndex: number };

/** The open row that counted this refund as made, or "owed" when one already owes it, or null. */
async function findOwner(
  tx: Prisma.TransactionClient,
  payment: { id: string; status: string; amountCents: number; refundedAmountCents: number },
  refundId: string,
): Promise<OpenOwner | "owed" | null> {
  const rows = await tx.paymentRecoveryOperation.findMany({ where: { paymentId: payment.id, ...CARD_REFUND_OPERATION_WHERE } });
  if (rows.some((row) => row.idempotencyKey === buildCardRefundFailedLaterRecoveryKey(refundId))) return "owed";
  const open = rows.filter((row) => row.status !== PaymentRecoveryOperationStatus.SUCCEEDED);
  for (const row of open) {
    const plan = parseRefundAllocationPlan(row.allocationPlan) ?? [];
    if (plan.some((slice) => slice.failedRefundIds?.includes(refundId))) return "owed";
    const marked = plan.findIndex((slice) => slice.madeRefundId === refundId);
    if (marked >= 0) return { row, sliceIndex: marked };
  }
  // The payment as it stood before the failure: this refund still counted.
  const refunds = await tx.paymentRefund.findMany({
    where: { paymentId: payment.id },
    select: { stripeRefundId: true, paymentTransactionId: true, amountCents: true, status: true, createdAt: true, stripeCreatedAt: true },
  });
  const filled = cardRefundSliceFilledBy(
    {
      ...payment,
      recoveryOperations: rows,
      refunds: refunds.map((refund) => (refund.stripeRefundId === refundId ? { ...refund, status: "pending" } : refund)),
    },
    refundId,
  );
  if (!filled) return null;
  const row = open.find((each) => each.id === filled.operation.id);
  // A closed row's refund is owed by a row of its own. An open row with no plan
  // (a superseded intent's) re-derives what its charge still holds by itself.
  if (!row) return null;
  return parseRefundAllocationPlan(row.allocationPlan) ? { row, sliceIndex: filled.sliceIndex } : "owed";
}

/**
 * Decide one failed-later refund. Runs inside the ledger writer's transaction,
 * after its refund rows and mirror, under its Payment row lock.
 */
export async function keepFailedLaterCardRefundOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    refund,
    kind,
    paymentIntentId,
    cutoffSeconds,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    refund: FailedLaterRefundInput;
    kind: FailedLaterKind;
    /** The refund's intent, where the writer has it; else the charge's own. */
    paymentIntentId: string | null;
    cutoffSeconds: number | null;
  },
): Promise<{ debt?: FailedLaterCardRefundDebt; readAsRefused?: true }> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, bookingId: true, status: true, amountCents: true, refundedAmountCents: true },
  });
  if (!payment) return {};
  const owner = await findOwner(tx, payment, refund.id);
  if (owner === "owed") return {};

  if (owner) {
    const { row, sliceIndex } = owner;
    const held =
      row.status === PaymentRecoveryOperationStatus.PROCESSING ||
      (row.status === PaymentRecoveryOperationStatus.PENDING && row.attempts === 0);
    if (held) {
      if (kind === "replayed") return { readAsRefused: true };
      throw new FailedLaterRefundHeldError(refund.id, row.id);
    }
    const plan = parseRefundAllocationPlan(row.allocationPlan) ?? [];
    const replanned = plan.map((slice, index) => {
      if (index !== sliceIndex) return slice;
      return {
        paymentTransactionId: slice.paymentTransactionId,
        amountCents: slice.amountCents,
        stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix),
        failedRefundIds: [...(slice.failedRefundIds ?? []), refund.id],
      };
    });
    const dead = isDeadRow(row);
    const outcome = dead ? "re-planned-dead" : "re-planned";
    // Compare-and-set on the plan read: a write in between means this read is stale.
    const moved = await tx.paymentRecoveryOperation.updateMany({
      where: { id: row.id, status: row.status, allocationPlan: { equals: row.allocationPlan as Prisma.InputJsonValue } },
      data: { allocationPlan: replanned as unknown as Prisma.InputJsonValue, lastError: failedLaterLastError(refund.id, outcome) },
    });
    if (moved.count !== 1) throw new FailedLaterRefundHeldError(refund.id, row.id);
    return {
      debt: {
        outcome,
        operationId: row.id,
        bookingId: row.bookingId,
        paymentIntentId: row.paymentIntentId,
        amountCents: plan[sliceIndex]?.amountCents ?? refund.amount,
        stripeRefundId: refund.id,
      },
    };
  }

  if (refund.metadata?.bookingId !== payment.bookingId) {
    // Not the club's to re-send: made by hand in the Stripe dashboard, or a
    // legacy group refund that names no booking. The officers are told once.
    return kind === "transition"
      ? {
          debt: {
            outcome: "not-resent",
            operationId: null,
            bookingId: payment.bookingId,
            paymentIntentId,
            amountCents: refund.amount,
            stripeRefundId: refund.id,
          },
        }
      : {};
  }
  const intentId =
    paymentIntentId ??
    (await tx.paymentTransaction.findUnique({ where: { id: paymentTransactionId }, select: { stripePaymentIntentId: true } }))
      ?.stripePaymentIntentId ??
    null;
  if (!intentId) {
    logger.error({ stripeRefundId: refund.id, paymentTransactionId }, "A card refund that failed later names no card payment to refund again (#4104)");
    return {};
  }
  const outcome: FailedLaterCardRefundDebt["outcome"] =
    refund.metadata?.reason === CARD_REFUND_FAILED_LATER_REASON
      ? "raised-dead"
      : cutoffSeconds !== null && typeof refund.created === "number" && refund.created < cutoffSeconds
        ? "raised-backlog"
        : "raised";
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
        attempts: outcome === "raised" ? 0 : MAX_PAYMENT_RECOVERY_ATTEMPTS,
        nextRetryAt: new Date(),
        lastError: failedLaterLastError(refund.id, outcome),
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count !== 1) return {};
  const row = await tx.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey }, select: { id: true } });
  return {
    debt: {
      outcome,
      operationId: row.id,
      bookingId: payment.bookingId,
      paymentIntentId: intentId,
      amountCents: refund.amount,
      stripeRefundId: refund.id,
    },
  };
}

/** Each refund the ledger writer saw fail later, decided in its transaction, in the order it saw them. */
export async function keepFailedLaterCardRefundsOwed(
  tx: Prisma.TransactionClient,
  {
    paymentId,
    paymentTransactionId,
    seen,
    fallbackPaymentIntentId,
  }: {
    paymentId: string;
    paymentTransactionId: string;
    seen: ReadonlyArray<{ refund: FailedLaterRefundInput; kind: FailedLaterKind }>;
    fallbackPaymentIntentId?: string | null;
  },
): Promise<FailedLaterDecisions> {
  const decisions: FailedLaterDecisions = { debts: [], readAsRefused: [] };
  if (seen.length === 0) return decisions;
  const cutoffSeconds = await cardRefundFailedLaterCutoffSeconds(tx);
  for (const { refund, kind } of seen) {
    const paymentIntentId = stripeReferenceId(refund.payment_intent) ?? fallbackPaymentIntentId ?? null;
    const decided = await keepFailedLaterCardRefundOwed(tx, { paymentId, paymentTransactionId, refund, kind, paymentIntentId, cutoffSeconds });
    if (decided.debt) decisions.debts.push(decided.debt);
    if (decided.readAsRefused) decisions.readAsRefused.push(refund.id);
  }
  return decisions;
}

function alertMessage(debt: FailedLaterCardRefundDebt, amount: string): string {
  switch (debt.outcome) {
    case "raised":
    case "re-planned":
      return `Stripe accepted a card refund of ${amount} and later reported it failed, so no money went back. It is owed again and will be asked for again automatically.`;
    case "re-planned-dead":
      return `Stripe accepted a card refund of ${amount} and later reported it failed, so no money went back. It is still owed, and its retries are already spent: pay the member another way and close it under Refunds owed.`;
    case "raised-dead":
      return `Stripe accepted a retried card refund of ${amount} and later reported it failed too, so no money went back. It is still owed and will not be asked for again automatically: pay the member another way and close it under Refunds owed.`;
    case "raised-backlog":
      return `Stripe reported a card refund of ${amount} failed. It was made before this release could notice such failures, so it is not asked for again automatically: check whether the member has already been paid back, and close it under Refunds owed.`;
    case "not-resent":
      return `Stripe reported a card refund of ${amount} on this booking failed after accepting it. The app did not make it for this booking (a refund made in the Stripe dashboard, or a group refund), so it is not asked for again: check it in Stripe and pay the member back if they are owed.`;
  }
}

/**
 * The officers' alert, once per decision, after the commit that wrote it.
 * Never throws: the debt is already owed.
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
      await alertPaymentRecoveryOfficers(
        {
          bookingId: debt.bookingId,
          operationId: debt.operationId ?? undefined,
          amountCents: debt.amountCents,
          paymentIntentId: debt.paymentIntentId ?? "",
          errorMessage: alertMessage(debt, formatCents(debt.amountCents, format)),
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
