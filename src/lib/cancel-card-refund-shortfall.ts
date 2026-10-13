import { ManualRefundTaskKind, ManualRefundTaskStatus, type Prisma } from "@prisma/client";

import { nonCardCapturedCharges } from "@/lib/cancel-card-refund-shortfall-settle";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminManualRefundTaskAlert } from "@/lib/email";
import logger from "@/lib/logger";
import {
  CANCEL_CARD_SHORTFALL_KEY_PREFIX,
  cancelCardShortfallOccurrenceKey,
  cancelCardShortfallPart,
  type CancelCardShortfallPart,
  type CardShortfallTaskStatuses,
} from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #4097 (`INV-PAY-129`): AN OWN-CARD CANCEL'S REFUND THAT ITS CARD REFUND PLAN
 * CANNOT CARRY IS RECORDED, SPLIT BY WHAT CAN ACTUALLY HOLD IT.
 *
 * The paid cancel freezes its card refund plan in its claim
 * (`planStripeRefundAllocation`), from what the payment's captured Stripe
 * charges can still refund. The policy's refund comes from the payment record,
 * so when the two disagree the plan carries less - sometimes nothing. Before
 * this the rest was only logged and the member was told the whole amount had
 * been refunded.
 *
 * The rest is now split, under the claim's locks, by what the payment's
 * captured NON-card charges still hold (coordinator decision on PR #4122):
 *
 * - `bank`: up to that headroom, owed by bank transfer - its completion
 *   allocates on those charges first, so it can succeed;
 * - `check`: anything beyond it - the payment's records show it already
 *   refunded, or nothing holds it - which an officer checks before paying and
 *   dismisses if it was refunded. Nobody is told to pay it outright.
 *
 * Each part is a `CANCELLED_BOOKING_HAND_BACK` - the task a cash cancel raises
 * (#2262), so it counts in "Refunds owed" and off Net Collected while OPEN and
 * sits in the money-to-settle queue - keyed one per part per booking
 * (`cancelCardShortfallOccurrenceKey`), inserted `ON CONFLICT DO NOTHING` so a
 * replay never aborts the claim. A replay's hit must find the same OPEN row
 * at the same amount, or the claim throws rather than report a stale figure.
 */
export type CancelCardShortfall = {
  /** What the card refund carries. */
  cardCents: number;
  bank: { taskId: string; cents: number } | null;
  check: { taskId: string; cents: number } | null;
};

/** The two parts' sizes: what the non-card charges hold, and the rest. Pure. */
export function splitCardShortfall(shortfallCents: number, nonCardHeadroomCents: number): Record<CancelCardShortfallPart, number> {
  const bank = Math.max(0, Math.min(shortfallCents, nonCardHeadroomCents));
  return { bank, check: Math.max(0, shortfallCents - bank) };
}

function shortfallReason(part: CancelCardShortfallPart, bookingId: string, figures: { card: string; due: string; part: string }): string {
  const lead = `Booking ${bookingId} cancelled - its card refund could carry only ${figures.card} of the ${figures.due} refund due.`;
  return (
    part === "bank"
      ? `${lead} ${figures.part} of the rest is held by the payment's non-card charges: refund it to the member by bank transfer (#4097).`
      : `${lead} The payment's records show the remaining ${figures.part} already refunded, or nothing holds it. Check Stripe and the bank before paying; dismiss this with a note if it was refunded (#4097).`
  ).slice(0, MANUAL_REFUND_TASK_REASON_MAX);
}

async function raisePart(
  tx: Prisma.TransactionClient,
  params: { bookingId: string; paymentId: string; part: CancelCardShortfallPart; cents: number; reason: string },
): Promise<{ taskId: string; cents: number } | null> {
  if (params.cents <= 0) return null;
  const occurrenceKey = cancelCardShortfallOccurrenceKey(params.bookingId, params.part);
  const inserted = await tx.manualRefundTask.createMany({
    data: [
      {
        bookingId: params.bookingId,
        paymentId: params.paymentId,
        amountCents: params.cents,
        raisedAmountCents: params.cents,
        kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
        occurrenceKey,
        reason: params.reason,
      },
    ],
    skipDuplicates: true,
  });
  const task = await tx.manualRefundTask.findUnique({
    where: { occurrenceKey },
    select: { id: true, status: true, amountCents: true },
  });
  if (!task) throw new Error(`The card refund shortfall task for booking ${params.bookingId} was not written (#4097).`);
  // A replay that hit the key must find what this claim would have written.
  if (inserted.count === 0 && (task.status !== ManualRefundTaskStatus.OPEN || task.amountCents !== params.cents)) {
    throw new Error(
      `The card refund shortfall task ${task.id} for booking ${params.bookingId} already exists as ${task.status} for ${task.amountCents ?? "no"} cents, not OPEN for ${params.cents} (#4097).`,
    );
  }
  return { taskId: task.id, cents: params.cents };
}

export async function raiseCancelCardShortfallHandBack(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    paymentId: string;
    /** The policy's refund to the card. */
    refundAmountCents: number;
    /** What the frozen card refund plan carries. */
    plannedCardRefundCents: number;
    format: ClubFormat;
  },
): Promise<CancelCardShortfall | null> {
  const { bookingId, paymentId, refundAmountCents, format } = params;
  const cardCents = Math.max(0, params.plannedCardRefundCents);
  const shortfallCents = refundAmountCents - cardCents;
  if (shortfallCents <= 0) return null;
  const headroomCents = (await nonCardCapturedCharges(tx, paymentId)).reduce((sum, row) => sum + row.headroomCents, 0);
  const sizes = splitCardShortfall(shortfallCents, headroomCents);
  const figures = (cents: number) => ({ card: formatCents(cardCents, format), due: formatCents(refundAmountCents, format), part: formatCents(cents, format) });
  const raise = (part: CancelCardShortfallPart) =>
    raisePart(tx, { bookingId, paymentId, part, cents: sizes[part], reason: shortfallReason(part, bookingId, figures(sizes[part])) });
  const shortfall: CancelCardShortfall = { cardCents, bank: await raise("bank"), check: await raise("check") };
  logger.warn(
    { bookingId, paymentId, refundAmountCents, cardCents, bankCents: sizes.bank, checkCents: sizes.check },
    "Cancellation card refund plan covers less than the refund due; the remainder is recorded on hand-back tasks (#4097)",
  );
  return shortfall;
}

/** What a cancel's shortfall tasks stand at now, by part, for the booking page's narrative. */
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
  return statuses;
}

/**
 * #4097: tell the officers, once, as soon as the cancel commits. Admin
 * audience, so exempt from the per-booking "No emails" switch (#2258 rule 2),
 * as the cash cancel's alert is. Never throws: the tasks are the durable
 * record. The reason line says what each part is and whether the member was
 * emailed, so the alert never claims a message that did not go.
 */
export function alertCancelCardShortfall(
  data: {
    memberName: string;
    booking: { id: string; checkIn: Date; checkOut: Date };
    shortfall: CancelCardShortfall;
    days: number;
    refundPercentage: number;
    refundAmountCents: number;
    memberEmailed: boolean;
  },
  format: ClubFormat,
): void {
  const { booking, shortfall } = data;
  const bankCents = shortfall.bank?.cents ?? 0;
  const checkCents = shortfall.check?.cents ?? 0;
  const parts = [
    bankCents > 0 ? `${formatCents(bankCents, format)} to refund by bank transfer` : null,
    checkCents > 0 ? `${formatCents(checkCents, format)} to check before paying (the payment's records show it already refunded, or nothing holds it)` : null,
  ].filter(Boolean);
  const told = data.memberEmailed
    ? "The member's cancellation email names what went to the card and the rest."
    : "The member was not emailed about this cancellation.";
  sendAdminManualRefundTaskAlert(
    {
      memberName: data.memberName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      refundAmountCents: bankCents + checkCents,
      bookingId: booking.id,
      reason: `Card cancellation ${data.days} day(s) before check-in (${data.refundPercentage}% under the policy in effect at the time): the card refund carries ${formatCents(shortfall.cardCents, format)} of the ${formatCents(data.refundAmountCents, format)} refund due; ${parts.join("; ")}. ${told}`,
      situation: "card-refund-shortfall",
    },
    format,
  ).catch((err) =>
    logger.error(
      { err, bookingId: booking.id, bankTaskId: shortfall.bank?.taskId, checkTaskId: shortfall.check?.taskId },
      "Failed to alert admins about a card refund shortfall's hand-back tasks",
    ),
  );
}
