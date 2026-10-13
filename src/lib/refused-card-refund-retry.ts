/**
 * #4083, #4096 (`INV-PAY-127`): A CARD REFUND STRIPE REFUSES ON A BOOKING EDIT
 * OR A CANCELLATION IS STILL OWED, AND IS ASKED FOR AGAIN UNDER A KEY STRIPE
 * HAS NEVER SEEN.
 *
 * Stripe can answer a refund with `failed` or `canceled` instead of throwing.
 * `refundPaymentTransactions` records that refund (the ledger does not count
 * it, `isRecordedRefundStatus`) and returns normally, so before this a booking
 * edit's refund queued nothing, a cancellation closed its pre-persisted debt as
 * paid, and the recovery runner closed any refund row whose replay read one.
 *
 * Stripe answers a repeated idempotency key with its ORIGINAL response for 24
 * hours, so a refused slice asked for again under its own key only reads the
 * refusal back. Whoever READS a refusal therefore moves that slice to its next
 * key generation (`nextRefusedRefundKeySuffix`), a key never sent before:
 *
 * - The edit's door queues the refused slices already moved, as its recovery
 *   row's plan, so "Refunds owed" counts them (`openCardRefundOwedByOperation`).
 * - The cancellation moves its pre-persisted row's plan the same way, only while
 *   no worker has touched it (PENDING, no attempt yet).
 * - The runner, on the attempt it holds, does the same and fails the attempt,
 *   so the backoff asks again.
 *
 * When Stripe answered EVERY slice, the rewritten plan is the refused slices
 * alone: a slice Stripe made is recorded and never sent again, so a replay past
 * Stripe's 24-hour window cannot make it twice. When a later slice threw, the
 * plan keeps every slice and only the refused ones move: the slice that threw
 * may have been made at Stripe, and must be replayed under its own key.
 *
 * The officers are alerted once per row, by whoever moves it off its first
 * keys. Retries spent: the row dies owed and alerted, for the treasurer's
 * "Paid another way" (#3372).
 */
import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { buildBookingCancellationRefundIdempotencyKey, nextRefusedRefundKeySuffix } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/** The slices Stripe answered but refused, as `refundPaymentTransactions` sent them. */
export function refusedRefundSlices(
  refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }>,
): RefundAllocationSlice[] {
  return refunds.filter((refund) => isRefusedRefundStatus(refund.status)).map((refund) => refund.slice);
}

export function refusedRefundCents(slices: ReadonlyArray<RefundAllocationSlice>): number {
  return slices.reduce((sum, slice) => sum + slice.amountCents, 0);
}

/** What the officers read, on the alert and as the row's last error. */
export function refusedRefundMessage(cents: number, format: ClubFormat): string {
  return `Stripe refused ${formatCents(cents, format)} of this card refund (failed or cancelled), so no money went back and it is still owed.`;
}

/** One Stripe request: the same slice under the same key (`refundSliceStripeIdempotencyKey`). */
function sameRequest(left: RefundAllocationSlice, right: RefundAllocationSlice): boolean {
  return (
    left.paymentTransactionId === right.paymentTransactionId &&
    left.amountCents === right.amountCents &&
    (left.stripeKeySuffix ?? "") === (right.stripeKeySuffix ?? "")
  );
}

/** The plan with each slice Stripe refused moved to its next key generation, the rest untouched. */
export function planAfterRefusals(
  plan: ReadonlyArray<RefundAllocationSlice>,
  refused: ReadonlyArray<RefundAllocationSlice>,
): RefundAllocationSlice[] {
  return plan.map((slice) =>
    refused.some((each) => sameRequest(each, slice))
      ? { ...slice, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) }
      : slice,
  );
}

/** Whether a plan is still on its first keys: no slice has been read refused yet. */
function onFirstKeys(plan: ReadonlyArray<RefundAllocationSlice>): boolean {
  return !plan.some((slice) => slice.stripeKeySuffix);
}

/**
 * The officers' alert for a refusal, raised by whoever moves a row off its
 * first keys - once per row, however many attempts follow. Never throws: the
 * refusal is already recorded on the row.
 */
export async function alertRefusedCardRefund(
  alert: { bookingId: string; operationId?: string; paymentIntentId: string; refusedCents: number },
  format: ClubFormat,
): Promise<void> {
  await alertPaymentRecoveryOfficers(
    {
      bookingId: alert.bookingId,
      operationId: alert.operationId,
      amountCents: alert.refusedCents,
      paymentIntentId: alert.paymentIntentId,
      errorMessage: refusedRefundMessage(alert.refusedCents, format),
    },
    format,
  ).catch((err: unknown) =>
    logger.error({ err, bookingId: alert.bookingId }, "Could not alert the officers to a refused card refund (#4083)"),
  );
}

/**
 * A cancellation's refund that Stripe refused, every slice answered (#4096):
 * its pre-persisted row is re-planned to the refused slices alone, each moved
 * to its next key, and its amount to what was refused - only while no worker
 * has touched it (PENDING, no attempt), as the runner owns it after that and
 * reads the refusal itself. Returns the error the cancel records on the row.
 */
export async function keepRefusedCancellationRefundOwed({
  bookingId,
  refused,
  format,
}: {
  bookingId: string;
  refused: ReadonlyArray<RefundAllocationSlice>;
  format: ClubFormat;
}): Promise<Error> {
  const refusedCents = refusedRefundCents(refused);
  const message = refusedRefundMessage(refusedCents, format);
  const idempotencyKey = buildBookingCancellationRefundIdempotencyKey(bookingId);
  try {
    const moved = await prisma.paymentRecoveryOperation.updateMany({
      where: { idempotencyKey, status: PaymentRecoveryOperationStatus.PENDING, attempts: 0 },
      data: {
        allocationPlan: planAfterRefusals(refused, refused) as unknown as Prisma.InputJsonValue,
        amountCents: refusedCents,
        lastError: message,
      },
    });
    if (moved.count === 1) {
      const row = await prisma.paymentRecoveryOperation.findUnique({
        where: { idempotencyKey },
        select: { id: true, paymentIntentId: true },
      });
      if (row) await alertRefusedCardRefund({ bookingId, operationId: row.id, paymentIntentId: row.paymentIntentId, refusedCents }, format);
    }
  } catch (err) {
    // The row stays open either way; the runner reads the refusal itself.
    logger.error({ err, bookingId }, "Could not re-plan a refused cancellation refund (#4096)");
  }
  return new Error(message);
}

/**
 * Written only on the attempt this worker holds - fenced on PROCESSING and its
 * own `processingStartedAt` - and never a status: the attempt's failure is the
 * runner's own write. A lost fence moves nothing, and the next attempt replays
 * the old key, reads the same refusal back and moves it then. Says whether it
 * moved the row.
 */
async function moveRefusedSlices(
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt">,
  plan: RefundAllocationSlice[],
  amountCents: number | undefined,
): Promise<boolean> {
  const moved = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: { allocationPlan: plan as unknown as Prisma.InputJsonValue, ...(amountCents === undefined ? {} : { amountCents }) },
  });
  return moved.count === 1;
}

/**
 * The recovery runner's refund of a frozen plan. Returns when Stripe made every
 * slice; otherwise moves what it refused to fresh keys and throws, so the
 * attempt fails and is retried (or, retries spent, dies owed).
 */
export async function refundPlanOrRetryRefusals({
  operation,
  plan,
  format,
  refund,
}: {
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt" | "bookingId" | "paymentIntentId">;
  plan: ReadonlyArray<RefundAllocationSlice>;
  format: ClubFormat;
  /** Sends the plan (`refundPaymentTransactions` with it as the allocation). */
  refund: (
    plan: RefundAllocationSlice[],
  ) => Promise<{ refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }> }>;
}): Promise<void> {
  const alertIfFirst = async (moved: boolean, refused: ReadonlyArray<RefundAllocationSlice>) => {
    if (moved && onFirstKeys(plan)) {
      await alertRefusedCardRefund(
        { bookingId: operation.bookingId, operationId: operation.id, paymentIntentId: operation.paymentIntentId, refusedCents: refusedRefundCents(refused) },
        format,
      );
    }
  };
  let refused: RefundAllocationSlice[];
  try {
    refused = refusedRefundSlices((await refund([...plan])).refunds);
  } catch (err) {
    // A slice refused before a later one threw (`PartialRefundError`) moves on
    // in place; the rest keep their keys, the slice that threw included.
    const before = (err as { refusedSlices?: RefundAllocationSlice[] } | null)?.refusedSlices ?? [];
    if (before.length > 0) await alertIfFirst(await moveRefusedSlices(operation, planAfterRefusals(plan, before), undefined), before);
    throw err;
  }
  if (refused.length === 0) return;
  // Every slice answered: what Stripe made is recorded and leaves the plan.
  await alertIfFirst(await moveRefusedSlices(operation, planAfterRefusals(refused, refused), refusedRefundCents(refused)), refused);
  throw new Error(refusedRefundMessage(refusedRefundCents(refused), format));
}
