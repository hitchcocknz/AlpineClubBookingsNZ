/**
 * #4083, #4096, #4102 (`INV-PAY-128`): A CARD REFUND STRIPE REFUSES ON A
 * BOOKING EDIT, A CANCELLATION OR AN APPROVED REFUND REQUEST IS STILL OWED, AND
 * IS ASKED FOR AGAIN UNDER A KEY STRIPE HAS NEVER SEEN.
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
 * - An approved refund request queues what its attempt did not make, refused
 *   slices already moved (`inlineRefundNotMade`, #4102).
 * - The runner, on the attempt it holds, does the same and fails the attempt,
 *   so the backoff asks again.
 *
 * The runner and the cancellation keep every slice in the plan and the row's
 * amount as the plan's total (`planAfterAttempt`): a slice Stripe made beside
 * a refusal is marked with its refund and never sent again - so a replay past
 * Stripe's 24-hour window cannot make it twice - and the owed figure still
 * fills it as this row's. A slice that threw keeps its key: it may have been
 * made at Stripe, and must be replayed under it.
 *
 * The officers are alerted for the refusal once per row, by whoever moves it
 * off its first keys (or, when no row could be written, by the door that met
 * it), and again if the retries run out; the row then dies owed, for the
 * treasurer's "Paid another way" (#3372).
 */
import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { buildBookingCancellationRefundIdempotencyKey, nextRefusedRefundKeySuffix } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { PartialRefundError, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/** One slice's answer from `refundPaymentTransactions`: the refund Stripe gave, with the slice as sent. */
type AnsweredRefund = { status: string | null; slice: RefundAllocationSlice; refundId: string; paymentIntentId: string };

/** The answers that were refusals. */
export function refusedAnswers<T extends { status: string | null }>(refunds: ReadonlyArray<T>): T[] {
  return refunds.filter((refund) => isRefusedRefundStatus(refund.status));
}

/** The slices Stripe answered but refused, as `refundPaymentTransactions` sent them. */
export function refusedRefundSlices(
  refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }>,
): RefundAllocationSlice[] {
  return refusedAnswers(refunds).map((refund) => refund.slice);
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

/**
 * The plan after an attempt Stripe answered (#4083 review): each slice it
 * refused moves to its next key; each it made is marked with its refund
 * (`madeRefundId`), so it is never sent again yet stays this row's - the
 * owed figure still fills it with that refund, and the row's amount stays the
 * plan's total. A slice with no answer (it threw, or was not reached) keeps its
 * key: it may have been made at Stripe, and must be replayed under it.
 */
export function planAfterAttempt(
  plan: ReadonlyArray<RefundAllocationSlice>,
  answered: ReadonlyArray<Pick<AnsweredRefund, "status" | "slice" | "refundId">>,
): RefundAllocationSlice[] {
  return plan.map((slice) => {
    if (slice.madeRefundId) return slice;
    const answer = answered.find((each) => sameRequest(each.slice, slice));
    if (!answer) return slice;
    return isRefusedRefundStatus(answer.status)
      ? { ...slice, stripeKeySuffix: nextRefusedRefundKeySuffix(slice.stripeKeySuffix) }
      : { ...slice, madeRefundId: answer.refundId };
  });
}

/**
 * #4102: what an inline attempt over a frozen plan did NOT make, for a door
 * that raises its recovery row after the attempt (an approved refund
 * request), with the slices Stripe refused. `refundPaymentTransactions` sends
 * the plan in order and stops at the first slice that throws, wrapping any
 * throw after a Stripe call in `PartialRefundError` with the slices answered
 * before it; any other throw came before one, so the whole plan is unsent.
 *
 * - Each slice Stripe refused moves to its next key, as it was read refused.
 * - Each with no answer (it threw, or was never sent) keeps its key: it may
 *   have been made at Stripe, and must be replayed under it.
 * - Each made is LEFT OUT, not marked (`madeRefundId`): its refund was made
 *   before the row existed, so "Refunds owed" could never fill it
 *   (`operationWindowTakes`) and would count it as still owed.
 */
export function inlineRefundNotMade(
  plan: RefundAllocationSlice[],
  attempt: { refunds: ReadonlyArray<{ status: string | null; slice: RefundAllocationSlice }> } | { error: unknown },
): { plan: RefundAllocationSlice[]; refused: RefundAllocationSlice[] } {
  const notMade = (answeredCount: number, refused: RefundAllocationSlice[]) => {
    const refusedHere = plan.slice(0, answeredCount).filter((slice) => refused.some((each) => sameRequest(each, slice)));
    return { plan: [...planAfterRefusals(refusedHere, refused), ...plan.slice(answeredCount)], refused };
  };
  if (!("error" in attempt)) return notMade(attempt.refunds.length, refusedRefundSlices(attempt.refunds));
  return attempt.error instanceof PartialRefundError
    ? notMade(attempt.error.refunds.length, attempt.error.refusedSlices)
    : { plan, refused: [] };
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
  try {
    await alertPaymentRecoveryOfficers(
      {
        bookingId: alert.bookingId,
        operationId: alert.operationId,
        amountCents: alert.refusedCents,
        paymentIntentId: alert.paymentIntentId,
        errorMessage: refusedRefundMessage(alert.refusedCents, format),
      },
      format,
    );
  } catch (err) {
    logger.error({ err, bookingId: alert.bookingId }, "Could not alert the officers to a refused card refund (#4083)");
  }
}

/**
 * A cancellation's refund that Stripe refused, every slice answered (#4096):
 * its pre-persisted row is re-planned (`planAfterAttempt`) - refused slices on
 * their next key, made ones marked - only while no worker has touched it
 * (PENDING, no attempt), as the runner owns it after that and reads the
 * refusal itself. Its amount stays the plan's total. The officers are alerted
 * when this write moved the row, with what is in hand if the row cannot be read
 * back. Returns the error the cancel records on the row.
 */
export async function keepRefusedCancellationRefundOwed({
  bookingId,
  answered,
  format,
}: {
  bookingId: string;
  answered: ReadonlyArray<AnsweredRefund>;
  format: ClubFormat;
}): Promise<Error> {
  const refused = refusedAnswers(answered);
  const refusedCents = refusedRefundCents(refused.map((answer) => answer.slice));
  const message = refusedRefundMessage(refusedCents, format);
  const idempotencyKey = buildBookingCancellationRefundIdempotencyKey(bookingId);
  let moved = false;
  try {
    const written = await prisma.paymentRecoveryOperation.updateMany({
      where: { idempotencyKey, status: PaymentRecoveryOperationStatus.PENDING, attempts: 0 },
      data: {
        allocationPlan: planAfterAttempt(answered.map((answer) => answer.slice), answered) as unknown as Prisma.InputJsonValue,
        lastError: message,
      },
    });
    moved = written.count === 1;
  } catch (err) {
    // The row stays open either way; the runner reads the refusal itself.
    logger.error({ err, bookingId }, "Could not re-plan a refused cancellation refund (#4096)");
  }
  if (moved) {
    let row: { id: string; paymentIntentId: string } | null = null;
    try {
      row = await prisma.paymentRecoveryOperation.findUnique({ where: { idempotencyKey }, select: { id: true, paymentIntentId: true } });
    } catch (err) {
      logger.error({ err, bookingId }, "Could not read back a re-planned cancellation refund; alerting with what is in hand (#4096)");
    }
    await alertRefusedCardRefund(
      { bookingId, operationId: row?.id, paymentIntentId: row?.paymentIntentId ?? refused[0]?.paymentIntentId ?? "", refusedCents },
      format,
    );
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
): Promise<boolean> {
  const moved = await prisma.paymentRecoveryOperation.updateMany({
    where: {
      id: operation.id,
      status: PaymentRecoveryOperationStatus.PROCESSING,
      processingStartedAt: operation.processingStartedAt,
    },
    data: { allocationPlan: plan as unknown as Prisma.InputJsonValue },
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
  /** Sends the slices still to send (`refundPaymentTransactions` with them as the allocation). */
  refund: (plan: RefundAllocationSlice[]) => Promise<{ refunds: ReadonlyArray<AnsweredRefund> }>;
}): Promise<void> {
  const alertIfFirst = async (moved: boolean, refused: ReadonlyArray<RefundAllocationSlice>) => {
    if (moved && onFirstKeys(plan)) {
      await alertRefusedCardRefund(
        { bookingId: operation.bookingId, operationId: operation.id, paymentIntentId: operation.paymentIntentId, refusedCents: refusedRefundCents(refused) },
        format,
      );
    }
  };
  let answered: ReadonlyArray<AnsweredRefund>;
  try {
    // A slice already made beside a refusal is never sent again.
    answered = (await refund(plan.filter((slice) => !slice.madeRefundId))).refunds;
  } catch (err) {
    // The slices answered before a later one threw (`PartialRefundError`): a
    // refusal among them re-plans the row; the slice that threw keeps its key.
    const before = ((err as { refunds?: AnsweredRefund[] } | null)?.refunds ?? []).filter((answer) => answer?.slice);
    const refusedBefore = refusedRefundSlices(before);
    if (refusedBefore.length > 0) await alertIfFirst(await moveRefusedSlices(operation, planAfterAttempt(plan, before)), refusedBefore);
    throw err;
  }
  const refused = refusedRefundSlices(answered);
  if (refused.length === 0) return;
  await alertIfFirst(await moveRefusedSlices(operation, planAfterAttempt(plan, answered)), refused);
  throw new Error(refusedRefundMessage(refusedRefundCents(refused), format));
}
