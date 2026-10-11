import { BookingStatus, ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";

import { groupSettlementRefundKey } from "@/lib/booking-ledger-posting-keys";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import { groupOrganiserHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { sendAdminManualRefundTaskAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #4042 (`INV-PAY-123`): THE HAND-BACK AN ORGANISER'S INTERNET BANKING GROUP
 * CANCEL OWES THE ORGANISER.
 *
 * When the organiser cancels a group they paid for with one Internet Banking
 * settlement, `group-cancel.ts` records each joiner's share as refunded in the
 * app - the child payment's mirror and its `BANK_REFUND` ledger line - but no
 * Stripe refund can back it: the club repays the organiser by bank transfer.
 * This keeps the one `ManualRefundTask` that asks an officer to do so, the same
 * kind the cash cancel raises (`CANCELLED_BOOKING_HAND_BACK`), on the
 * organiser's booking.
 *
 * - **Where.** Inside each per-child claim transaction that books a joiner's
 *   share, after its `lock(1)`, so every refund the ledger records commits with
 *   the task that makes it real, and a rolled-back claim adds nothing.
 * - **One task, growing.** The first share creates it, keyed one per settlement;
 *   each later share adds itself to it while it is OPEN, by a status-guarded
 *   update under the same `lock(1)` (which the task's completion also takes),
 *   so the task is always exactly the shares booked. A share booked after the
 *   task was closed raises a SUPPLEMENTARY task keyed per joiner, never a second
 *   copy of the first.
 * - **A resumed cancel.** When the first share this release books is not the
 *   group's first - a cancel interrupted across the release that added this -
 *   the task also counts each earlier joiner the ledger shows this cancel
 *   refunded (its `groupSettlementRefundKey` line).
 * - **No `paymentId`.** The refund is already recorded on each joiner's own
 *   payment, so completing the task takes no settlement route: it writes no
 *   second allocation, ledger line, Xero note or booking event.
 */
export type GroupOrganiserHandBack = {
  id: string;
  amountCents: number;
  reason: string;
  /** True when this call created the task, so its run alerts once after commit. */
  created: boolean;
};

const REASON_LEAD = "Group cancelled by its organiser - paid by Internet Banking.";
const SHARES_LABEL = " Joiners' shares: ";
const MORE_PATTERN = / … and (\d+) more \(see each joiner's booking\)\.$/;

/**
 * The task's reason: the lead, what to repay, and each joiner's share, listed
 * while they fit the column and then counted (`… and N more`). Pure, and the
 * inverse of `readGroupHandBackReasonShares`, so a share added later appends.
 */
export function composeGroupHandBackReason(input: {
  totalCents: number;
  shares: readonly string[];
  more: number;
  supplementary: boolean;
  format: ClubFormat;
}): string {
  const total = formatCents(input.totalCents, input.format);
  const head = input.supplementary
    ? `${REASON_LEAD} A joiner's refund was recorded after the group's repayment task was closed: repay the organiser ${total} by bank transfer.${SHARES_LABEL}`
    : `${REASON_LEAD} Repay the organiser ${total} by bank transfer.${SHARES_LABEL}`;
  for (let listed = input.shares.length; listed >= 0; listed -= 1) {
    const hidden = input.more + input.shares.length - listed;
    const tail = hidden > 0 ? ` … and ${hidden} more (see each joiner's booking).` : ".";
    const reason = `${head}${input.shares.slice(0, listed).join(", ")}${tail}`;
    if (reason.length <= MANUAL_REFUND_TASK_REASON_MAX) return reason;
  }
  return head.slice(0, MANUAL_REFUND_TASK_REASON_MAX);
}

/** The listed shares and the counted remainder of a reason `composeGroupHandBackReason` wrote. */
export function readGroupHandBackReasonShares(reason: string): { shares: string[]; more: number } {
  const at = reason.indexOf(SHARES_LABEL);
  if (at < 0) return { shares: [], more: 0 };
  let list = reason.slice(at + SHARES_LABEL.length);
  const more = MORE_PATTERN.exec(list);
  list = more ? list.slice(0, more.index) : list.replace(/\.$/, "");
  return { shares: list ? list.split(", ") : [], more: more ? Number(more[1]) : 0 };
}

const OWNER_NAME_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  member: { select: { firstName: true, lastName: true } },
  organisation: { select: { name: true, email: true } },
});

function shareLabel(
  child: { member: { firstName: string; lastName: string } | null; organisation: { name: string; email: string | null } | null },
  cents: number,
  format: ClubFormat,
): string {
  const { firstName, lastName } = bookingOwner(child).member;
  return `${[firstName, lastName].filter(Boolean).join(" ")} ${formatCents(cents, format)}`;
}

/**
 * Book one joiner's share on the organiser's hand-back, inside that joiner's
 * claim transaction and after its `lock(1)`. Returns the task it created or
 * grew, or null when the plan owes nothing for this joiner.
 */
export async function recordGroupOrganiserHandBackShare(
  tx: Prisma.TransactionClient,
  input: {
    settlementId: string;
    organiserBookingId: string;
    /** The settlement's frozen `{childId: cents}` plan. */
    plan: ReadonlyMap<string, number>;
    /** The joiner whose claim, in this transaction, books its share. */
    claimedChildId: string;
    format: ClubFormat;
  },
): Promise<GroupOrganiserHandBack | null> {
  const shareCents = input.plan.get(input.claimedChildId) ?? 0;
  if (shareCents <= 0) return null;
  const claimed = await tx.booking.findUniqueOrThrow({ where: { id: input.claimedChildId }, select: OWNER_NAME_SELECT });
  const label = shareLabel(claimed, shareCents, input.format);
  const occurrenceKey = groupOrganiserHandBackOccurrenceKey(input.settlementId);
  const task = await tx.manualRefundTask.findUnique({
    where: { occurrenceKey },
    select: { id: true, status: true, amountCents: true, reason: true },
  });

  if (!task) {
    const earlier = await sharesBookedBeforeThisRelease(tx, input);
    const amountCents = earlier.reduce((sum, share) => sum + share.cents, 0) + shareCents;
    const reason = composeGroupHandBackReason({
      totalCents: amountCents,
      shares: [...earlier.map((share) => share.label), label],
      more: 0,
      supplementary: false,
      format: input.format,
    });
    const created = await createHandBack(tx, { bookingId: input.organiserBookingId, occurrenceKey, amountCents, reason });
    return { ...created, amountCents, created: true };
  }

  if (task.status === ManualRefundTaskStatus.OPEN) {
    const amountCents = (task.amountCents ?? 0) + shareCents;
    const listed = readGroupHandBackReasonShares(task.reason);
    const reason = composeGroupHandBackReason({
      totalCents: amountCents,
      shares: [...listed.shares, label],
      more: listed.more,
      supplementary: false,
      format: input.format,
    });
    const grown = await tx.manualRefundTask.updateMany({
      where: { id: task.id, status: ManualRefundTaskStatus.OPEN },
      data: { amountCents: { increment: shareCents }, raisedAmountCents: { increment: shareCents }, reason },
    });
    if (grown.count === 1) return { id: task.id, amountCents, reason, created: false };
  }

  // The settlement's task was closed before this share was booked: this share
  // is still owed to the organiser, on a task of its own.
  const supplementaryKey = groupOrganiserHandBackOccurrenceKey(input.settlementId, input.claimedChildId);
  const existing = await tx.manualRefundTask.findUnique({ where: { occurrenceKey: supplementaryKey }, select: { id: true } });
  if (existing) return null;
  const reason = composeGroupHandBackReason({ totalCents: shareCents, shares: [label], more: 0, supplementary: true, format: input.format });
  const created = await createHandBack(tx, { bookingId: input.organiserBookingId, occurrenceKey: supplementaryKey, amountCents: shareCents, reason });
  return { ...created, amountCents: shareCents, created: true };
}

/**
 * The planned joiners (other than this claim's) a cancel interrupted across the
 * release that added this had already refunded: cancelled, not deleted (the
 * loop's own rule), with this settlement's refund line on their ledger.
 */
async function sharesBookedBeforeThisRelease(
  tx: Prisma.TransactionClient,
  input: { settlementId: string; plan: ReadonlyMap<string, number>; claimedChildId: string; format: ClubFormat },
): Promise<Array<{ label: string; cents: number }>> {
  const plannedIds = [...input.plan].filter(([id, cents]) => cents > 0 && id !== input.claimedChildId).map(([id]) => id);
  if (plannedIds.length === 0) return [];
  const lines = await tx.bookingLedgerLine.findMany({
    where: { postingKey: { in: plannedIds.map((id) => groupSettlementRefundKey(input.settlementId, id)) } },
    select: { bookingId: true },
  });
  if (lines.length === 0) return [];
  const children = await tx.booking.findMany({
    where: { id: { in: lines.map((line) => line.bookingId) }, deletedAt: null, status: BookingStatus.CANCELLED },
    orderBy: { id: "asc" },
    select: { id: true, ...OWNER_NAME_SELECT },
  });
  return children.map((child) => {
    const cents = input.plan.get(child.id) ?? 0;
    return { label: shareLabel(child, cents, input.format), cents };
  });
}

async function createHandBack(
  tx: Prisma.TransactionClient,
  data: { bookingId: string; occurrenceKey: string; amountCents: number; reason: string },
): Promise<{ id: string; reason: string }> {
  return tx.manualRefundTask.create({
    data: {
      bookingId: data.bookingId,
      amountCents: data.amountCents,
      raisedAmountCents: data.amountCents,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: data.occurrenceKey,
      reason: data.reason,
    },
    select: { id: true, reason: true },
  });
}

/**
 * #4042: the finance alert for a hand-back this run's claim CREATED, sent
 * straight after that claim commits - the cash cancel's "Manual refund needed"
 * email in its group wording. Never from a claim that only grew the task, never
 * inside the transaction, never after a rollback (the caller only has the task
 * once the claim committed). Best-effort: the task is the record and this is
 * the nudge, so it never throws.
 */
export async function alertGroupOrganiserHandBack(input: {
  organiserBookingId: string;
  task: GroupOrganiserHandBack;
  format: ClubFormat;
}): Promise<void> {
  try {
    const organiserBooking = await prisma.booking.findUniqueOrThrow({
      where: { id: input.organiserBookingId },
      select: { checkIn: true, checkOut: true, ...OWNER_NAME_SELECT },
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
