/**
 * #4083 (`INV-PAY-124`): A CARD REFUND STRIPE REFUSES IS STILL OWED, AND IS
 * ASKED FOR AGAIN UNDER A KEY STRIPE HAS NEVER SEEN.
 *
 * Stripe can answer a refund with `failed` or `canceled` instead of throwing.
 * `refundPaymentTransactions` records that refund (the ledger does not count
 * it, `isRecordedRefundStatus`) and returns normally, so before this a booking
 * edit's refund queued nothing, a cancellation closed its pre-persisted debt as
 * paid, and the recovery runner closed any refund row whose replay read one.
 *
 * - The edit's refund queues the slices Stripe refused as its recovery row's
 *   plan (`executeBookingModificationRefund`), so "Refunds owed" counts them
 *   (`openCardRefundOwedByOperation`); a cancellation leaves its row open.
 * - The runner never closes a row on a refusal. Stripe answers a repeated key
 *   with its ORIGINAL response for 24 hours, so a replay under the refused
 *   key would read the refusal back on every attempt until the retries ran
 *   out. Each slice it READ refused moves to its next key generation
 *   (`nextRefusedRefundKeySuffix`) and the attempt fails, so the backoff asks
 *   again under a fresh key. A slice it did not read refused keeps its key, so
 *   a refund made but not recorded is still answered with the original, never
 *   made twice. Retries spent: the row is dead and still owed, alerted, for the
 *   treasurer's "Paid another way" (#3372).
 */
import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import { nextRefusedRefundKeySuffix } from "@/lib/payment-recovery-keys";
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

/**
 * Written only on the attempt this worker holds - fenced on PROCESSING and its
 * own `processingStartedAt`, as the stale reaper fences - and never a status:
 * the attempt's failure is the runner's own write. A lost fence moves nothing,
 * and the next attempt replays the old key, reads the same refusal back and
 * moves it then.
 */
async function moveRefusedSlices(
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt">,
  plan: ReadonlyArray<RefundAllocationSlice>,
  refused: ReadonlyArray<RefundAllocationSlice>,
): Promise<void> {
  await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: { allocationPlan: planAfterRefusals(plan, refused) as unknown as Prisma.InputJsonValue },
  });
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
  operation: Pick<PaymentRecoveryOperation, "id" | "processingStartedAt">;
  plan: ReadonlyArray<RefundAllocationSlice>;
  format: ClubFormat;
  refund: () => Promise<{ refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }> }>;
}): Promise<void> {
  let refused: RefundAllocationSlice[];
  try {
    refused = refusedRefundSlices((await refund()).refunds);
  } catch (err) {
    // A slice refused before a later one threw (`PartialRefundError`) moves on too.
    const before = (err as { refusedSlices?: RefundAllocationSlice[] } | null)?.refusedSlices ?? [];
    if (before.length > 0) await moveRefusedSlices(operation, plan, before);
    throw err;
  }
  if (refused.length === 0) return;
  await moveRefusedSlices(operation, plan, refused);
  throw new Error(
    `Stripe refused ${formatCents(refusedRefundCents(refused), format)} of this card refund (failed or canceled); it is still owed and the retry asks under a fresh idempotency key (#4083)`,
  );
}
