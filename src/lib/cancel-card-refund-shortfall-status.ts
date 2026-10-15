import { PaymentRecoveryOperationStatus } from "@prisma/client";

import {
  CANCEL_CARD_SHORTFALL_KEY_PREFIX,
  cancelCardShortfallPart,
  closeKeysOf,
  type CardShortfallTaskStatuses,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  buildBookingCancellationRefundIdempotencyKey,
  CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import type { CardRefundState } from "@/lib/booking-narrative-cancelled-post-payment";
import { prisma } from "@/lib/prisma";

type CardRefundRow = { id: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };

/**
 * #4125: where one card refund recovery row stands. Closed `SUCCEEDED` is made,
 * unless its close is a "Paid another way" record (`closeKeysOf`); a row the
 * runner will still send is on its way (`isPaymentRecoveryOperationInFlight`);
 * any other is dead - stalled until the club acts.
 */
async function cardRefundRowState(row: CardRefundRow): Promise<CardRefundState> {
  if (row.status === PaymentRecoveryOperationStatus.SUCCEEDED) {
    const closed = await prisma.manualRefundTask.count({ where: { occurrenceKey: { in: closeKeysOf(row.id) } } });
    return closed > 0 ? "paid-another-way" : "settled";
  }
  return isPaymentRecoveryOperationInFlight(row) ? "on-its-way" : "stalled";
}

/**
 * #4097 (`INV-PAY-129`): WHERE A CARD REFUND SHORTFALL'S CANCEL STANDS, for the
 * booking page and the public payment-link page, which hand it to the pure
 * narrative. Each part's task status, and - only on a cancel that has such
 * tasks - the card part's own refund: settled, still on its way, or closed as
 * "Paid another way" (its record under `closeKeysOf`).
 *
 * No `server-only` and no heavier import than Prisma: the payment-link page's
 * context module must stay importable outside a React server
 * (`cli-server-only-reach-census.test.ts`).
 */
export async function readCardShortfallTaskStatuses(bookingId: string): Promise<CardShortfallTaskStatuses> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { bookingId, occurrenceKey: { startsWith: CANCEL_CARD_SHORTFALL_KEY_PREFIX } },
    select: { kind: true, occurrenceKey: true, status: true },
  });
  const statuses: CardShortfallTaskStatuses = {};
  for (const task of tasks ?? []) {
    const part = cancelCardShortfallPart(task);
    if (part) statuses[part] = task.status;
  }
  if (Object.keys(statuses).length === 0) return statuses;
  const cardRefund = await prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
    select: { id: true, status: true, attempts: true, nextRetryAt: true },
  });
  if (cardRefund) {
    // A dead card part still reads as owed here: the shortfall's own sentence has no "stalled" yet.
    const state = await cardRefundRowState(cardRefund);
    statuses.card = state === "stalled" ? "on-its-way" : state;
  }
  return statuses;
}

/**
 * #4125: WHERE A CARD CANCEL'S REFUND STANDS when no REFUNDED event says it was
 * made, for the same two pages. One read, of the cancel's card refund row - the
 * member's cancel (`booking_cancel_refund_recovery_<booking>`) or the capacity
 * race's (`capacity_claim_failed_refund_recovery_<booking>_<intent>`) - plus a
 * second only for a closed row, to tell a "Paid another way" close from a
 * refund made. No row reads as absent (`undefined`), which the narrative
 * takes as on its way. Several rows (a second intent's capacity race) read as
 * the one furthest from done: a dead one first, then one still being sent.
 */
export async function readCancelledCardRefundState(bookingId: string): Promise<CardRefundState | undefined> {
  const capacityRacePrefix = `${CAPACITY_CLAIM_FAILED_REFUND_RECOVERY_PREFIX}${bookingId}_`;
  const rows = await prisma.paymentRecoveryOperation.findMany({
    where: {
      OR: [
        { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
        { idempotencyKey: { startsWith: capacityRacePrefix } },
      ],
    },
    select: { id: true, idempotencyKey: true, status: true, attempts: true, nextRetryAt: true },
  });
  // `startsWith` is SQL LIKE, where `_` matches any one character, so the
  // trailing `_` alone would let booking `ab`'s read take booking `abc`'s rows.
  // The prefix is checked again here, exactly.
  const own = rows.filter((row) => row.idempotencyKey === buildBookingCancellationRefundIdempotencyKey(bookingId) || row.idempotencyKey.startsWith(capacityRacePrefix));
  const states = await Promise.all(own.map(cardRefundRowState));
  return FURTHEST_FROM_DONE_FIRST.find((state) => states.includes(state));
}

const FURTHEST_FROM_DONE_FIRST: readonly CardRefundState[] = ["stalled", "on-its-way", "paid-another-way", "settled"];
