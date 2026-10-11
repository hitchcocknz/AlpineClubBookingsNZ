import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import { bookingOwner } from "@/lib/booking-owner";
import { ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES } from "@/lib/booking-status";
import type { ClubFormat } from "@/lib/club-format";
import { groupOrganiserHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { sendAdminManualRefundTaskAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #4042 (`INV-PAY-120`): THE HAND-BACK AN ORGANISER'S INTERNET BANKING GROUP
 * CANCEL OWES THE ORGANISER.
 *
 * When the organiser cancels a group they paid for with one Internet Banking
 * settlement, `group-cancel.ts` records each joiner's share as refunded - the
 * child payment's mirror, its `BANK_REFUND` ledger line and its Xero refund
 * credit note - but no Stripe refund can back it: the club repays the
 * organiser by bank transfer. This raises the one `ManualRefundTask` that asks
 * an officer to do so, the same kind the cash cancel raises
 * (`CANCELLED_BOOKING_HAND_BACK`), on the organiser's booking.
 *
 * - **Where.** Inside the per-child claim transaction that writes a joiner's
 *   mirror, after its `lock(1)`, so the first refund the books record commits
 *   with the task that makes it real, and a rolled-back claim raises nothing.
 * - **Once.** Keyed one per settlement (`groupOrganiserHandBackOccurrenceKey`):
 *   the later children's claims and every re-drive find it and raise nothing.
 *   The read and the create run under the `lock(1)` every group-cancel writer
 *   holds; the unique key is the backstop.
 * - **How much.** The frozen plan's shares (never re-tiered), less any planned
 *   joiner already gone some other way when the first share is recorded: this
 *   cancel records no refund for that one, so it owes the organiser none.
 * - **No `paymentId`.** The refund is already recorded on each joiner's own
 *   payment, so completing the task takes no settlement route: it writes no
 *   second allocation, ledger line, Xero note or booking event.
 *
 * Returns the task it raised, or null when one already exists or nothing is owed.
 */
export type GroupOrganiserHandBack = { id: string; amountCents: number; reason: string };

export async function raiseGroupOrganiserHandBackTask(
  tx: Prisma.TransactionClient,
  input: {
    settlementId: string;
    organiserBookingId: string;
    /** The settlement's frozen `{childId: cents}` plan. */
    plan: ReadonlyMap<string, number>;
    /** The joiner whose claim, in this transaction, records the first share. */
    claimedChildId: string;
    format: ClubFormat;
  },
): Promise<GroupOrganiserHandBack | null> {
  const occurrenceKey = groupOrganiserHandBackOccurrenceKey(input.settlementId);
  const existing = await tx.manualRefundTask.findUnique({
    where: { occurrenceKey },
    select: { id: true },
  });
  if (existing) return null;

  const plannedIds = [...input.plan].filter(([, cents]) => cents > 0).map(([id]) => id);
  const children = await tx.booking.findMany({
    where: {
      id: { in: plannedIds },
      OR: [
        { id: input.claimedChildId },
        { status: { in: [...ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES] } },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      member: { select: { firstName: true, lastName: true } },
      organisation: { select: { name: true, email: true } },
    },
  });
  const shares = children.map((child) => {
    const { firstName, lastName } = bookingOwner(child).member;
    return { name: [firstName, lastName].filter(Boolean).join(" "), cents: input.plan.get(child.id) ?? 0 };
  });
  const amountCents = shares.reduce((sum, share) => sum + share.cents, 0);
  if (amountCents <= 0) return null;

  const perChild = shares.map((share) => `${share.name} ${formatCents(share.cents, input.format)}`).join(", ");
  const task = await tx.manualRefundTask.create({
    data: {
      bookingId: input.organiserBookingId,
      amountCents,
      raisedAmountCents: amountCents,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey,
      reason: `Group cancelled by its organiser - paid by Internet Banking. Repay the organiser ${formatCents(amountCents, input.format)} by bank transfer. Joiners' shares: ${perChild}.`.slice(
        0,
        MANUAL_REFUND_TASK_REASON_MAX,
      ),
    },
    select: { id: true, reason: true },
  });
  return { id: task.id, amountCents, reason: task.reason };
}

/**
 * #4042: the finance alert for a hand-back this run raised, after the claim
 * that raised it has committed - the cash cancel's "Manual refund needed"
 * email in its group wording. Sent once, by the run whose claim created the
 * task; best-effort, because the task is the record and this is the nudge.
 * Never throws: the organiser's cancellation has already committed.
 */
export async function alertGroupOrganiserHandBack(input: {
  organiserBookingId: string;
  task: GroupOrganiserHandBack;
  format: ClubFormat;
}): Promise<void> {
  try {
    const organiserBooking = await prisma.booking.findUniqueOrThrow({
      where: { id: input.organiserBookingId },
      select: {
        checkIn: true,
        checkOut: true,
        member: { select: { firstName: true, lastName: true } },
        organisation: { select: { name: true, email: true } },
      },
    });
    const { firstName, lastName } = bookingOwner(organiserBooking).member;
    await sendAdminManualRefundTaskAlert(
      {
        memberName: [firstName, lastName].filter(Boolean).join(" "),
        checkIn: organiserBooking.checkIn,
        checkOut: organiserBooking.checkOut,
        refundAmountCents: input.task.amountCents,
        bookingId: input.organiserBookingId,
        reason: input.task.reason,
        situation: "group-organiser-internet-banking",
      },
      input.format,
    );
  } catch (err) {
    logger.error(
      { err, organiserBookingId: input.organiserBookingId, manualRefundTaskId: input.task.id },
      "Failed to alert admins about a group organiser's hand-back task",
    );
  }
}
