import { PaymentRecoveryOperationStatus } from "@prisma/client";

import {
  CANCEL_CARD_SHORTFALL_KEY_PREFIX,
  cancelCardShortfallPart,
  closeKeysOf,
  paidAnotherWayUnpaidCents,
  type CardRefundState,
  type CardShortfallTaskStatuses,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  buildBookingCancellationRefundIdempotencyKey,
  bookingCancelCardRefundRecoveryWhere,
  buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking,
  isBookingCancelCardRefundRecoveryKey,
} from "@/lib/payment-recovery-keys";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";
import type { PaidAnotherWayClose } from "@/lib/booking-narrative-cancelled-post-payment";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { cardRefundMadeForOperation, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";

type CardRefundRow = { id: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };
/** A "Paid another way" close's record: what it paid back, and what the row still owed. */
type CloseRecord = { amountCents: number | null; raisedAmountCents: number | null };

/**
 * #4125: where a card cancel's refund stands on its recovery row, for the
 * narrative (`cardRefundState`); #4145: closed "Paid another way", what that
 * close's record says (`cardRefundClose`) - paid back, left unpaid, and made.
 */
export interface CancelledCardRefund {
  cardRefundState?: CardRefundState;
  cardRefundClose?: PaidAnotherWayClose;
  /**
   * #4145: what a capacity race's rows planned to refund, together - the most its
   * card refund can be, where its CANCELLED snapshot froze the full charge
   * (before #4125). Absent on a member's cancel.
   */
  cardRefundPlanCents?: number;
}

/**
 * #4125: where one card refund recovery row stands. Closed `SUCCEEDED` is made,
 * unless its close is a "Paid another way" record (`closeKeysOf`); a row the
 * runner will still send is on its way (`isPaymentRecoveryOperationInFlight`);
 * any other is dead - stalled until the club acts.
 */
async function cardRefundRowState(row: CardRefundRow): Promise<{ state: CardRefundState; record?: CloseRecord }> {
  if (row.status === PaymentRecoveryOperationStatus.SUCCEEDED) {
    const record = await prisma.manualRefundTask.findFirst({
      where: { occurrenceKey: { in: closeKeysOf(row.id) } },
      select: { amountCents: true, raisedAmountCents: true },
    });
    return record ? { state: "paid-another-way", record } : { state: "settled" };
  }
  return { state: isPaymentRecoveryOperationInFlight(row) ? "on-its-way" : "stalled" };
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
  if (cardRefund) statuses.card = (await cardRefundRowState(cardRefund)).state;
  return statuses;
}

/**
 * #4125: WHERE A CARD CANCEL'S REFUND STANDS when no REFUNDED event says it was
 * made, for the same two pages. One read, of the cancel's card refund row - the
 * member's cancel (`booking_cancel_refund_recovery_<booking>`) or the capacity
 * race's (`capacity_claim_failed_refund_recovery_<booking>_<intent>`) - plus a
 * second only for a closed row, to tell a "Paid another way" close from a
 * refund made, and read what its record says (#4145; summed over a capacity
 * race's rows) - with, from the row's payment, what its slices took from the
 * refunds recorded on it, by the rule the close used (`cardRefundMadeForOperation`). No row reads as absent (`undefined`), which the narrative
 * takes as on its way. Several rows (a second intent's capacity race) read as
 * the one furthest from done: a dead one first, then one still being sent.
 */
export async function readCancelledCardRefund(bookingId: string): Promise<CancelledCardRefund> {
  const rows = await prisma.paymentRecoveryOperation.findMany({
    // On `@@index([bookingId])`, so the prefix match never scans the table.
    where: bookingCancelCardRefundRecoveryWhere(bookingId),
    select: { id: true, idempotencyKey: true, paymentId: true, amountCents: true, allocationPlan: true, status: true, attempts: true, nextRetryAt: true },
  });
  // `startsWith` is SQL LIKE, where `_` matches any one character, so the query alone
  // would let booking `ab`'s read take booking `abc`'s rows: the exact rule decides (#4147).
  const own = rows.filter((row) => isBookingCancelCardRefundRecoveryKey(bookingId, row.idempotencyKey));
  const standings = await Promise.all(own.map(async (row) => ({ row, ...(await cardRefundRowState(row)) })));
  const cardRefundState = FURTHEST_FROM_DONE_FIRST.find((state) => standings.some((each) => each.state === state));
  const planned = capacityRacePlanCents(bookingId, own);
  if (cardRefundState !== "paid-another-way") return { cardRefundState, ...planned };
  const closed = standings.flatMap(({ row, record }) => (record ? [{ row, record }] : []));
  const payments = await prisma.payment.findMany({
    where: { id: { in: [...new Set(closed.map(({ row }) => row.paymentId))] } },
    select: { id: true, status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
  });
  const made = (row: { id: string; paymentId: string }) => {
    const payment = payments.find((each) => each.id === row.paymentId);
    return payment ? cardRefundMadeForOperation(payment, row.id).madeCents : 0;
  };
  return {
    cardRefundState,
    ...planned,
    cardRefundClose: {
      paidBackCents: closed.reduce((sum, { record }) => sum + (record.amountCents ?? 0), 0),
      unpaidCents: closed.reduce((sum, { record }) => sum + paidAnotherWayUnpaidCents(record), 0),
      madeCents: closed.reduce((sum, { row }) => sum + made(row), 0),
    },
  };
}

const FURTHEST_FROM_DONE_FIRST: readonly CardRefundState[] = ["stalled", "on-its-way", "paid-another-way", "settled"];

/** #4145: a capacity race's rows' frozen plans together (each row's amount where it has none), or nothing for a member's cancel. */
function capacityRacePlanCents(
  bookingId: string,
  rows: ReadonlyArray<{ idempotencyKey: string; amountCents: number; allocationPlan: unknown }>,
): { cardRefundPlanCents?: number } {
  const planned = rows
    .filter((row) => row.idempotencyKey.startsWith(buildCapacityClaimFailedRefundRecoveryKeyPrefixForBooking(bookingId)))
    .map((row) => parseRefundAllocationPlan(row.allocationPlan)?.reduce((sum, slice) => sum + slice.amountCents, 0) ?? row.amountCents);
  return planned.length > 0 && planned.every((cents) => typeof cents === "number") ? { cardRefundPlanCents: planned.reduce((sum, cents) => sum + cents, 0) } : {};
}
