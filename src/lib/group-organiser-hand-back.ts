import { ManualRefundTaskKind, ManualRefundTaskStatus, Prisma } from "@prisma/client";

import { groupSettlementRefundKey } from "@/lib/booking-ledger-posting-keys";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import {
  GROUP_ORGANISER_HAND_BACK_KEY_PREFIX,
  groupOrganiserHandBackOccurrenceKey,
  groupOrganiserHandBackTasksWhere,
  readGroupOrganiserHandBackShares,
  type GroupOrganiserHandBackShares,
} from "@/lib/group-organiser-hand-back-rules";
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
 *   share, after its `lock(1)` (which the task's completion also takes), so
 *   every refund the ledger records commits with the task that makes it real.
 * - **What it holds is DERIVED, never incremented.** Each claim recomputes the
 *   joiners owed: every planned joiner whose settlement refund line is on its
 *   ledger (`groupSettlementRefundKey` - the proof, so a joiner since
 *   soft-deleted, one a previous release claimed without growing the task, and
 *   one a cancel interrupted across releases refunded all count), every joiner
 *   a group task already records, and this claim's joiner. The open task holds
 *   that total less what closed group tasks already repaid, written by a
 *   status-guarded update; once the task is closed, a later share raises a
 *   SUPPLEMENTARY task keyed per joiner for only what no task covers.
 * - **Its shares are data** (`reviewContext.groupOrganiserHandBack`), and the
 *   reason is written from them, so a name with a comma in it cannot skew
 *   anything.
 * - **No `paymentId`.** The refund is already recorded on each joiner's own
 *   payment, so completing the task takes no settlement route: it writes no
 *   second allocation, ledger line, Xero note or booking event.
 */
export type GroupOrganiserHandBack = {
  id: string;
  amountCents: number;
  /** True when this call created the task, so its run alerts once, after the children. */
  created: boolean;
};

type Share = GroupOrganiserHandBackShares["shares"][number];

/**
 * The task's reason: the lead, what to repay, and each joiner's share, listed
 * while they fit the column and then counted (`… and N more`). Pure, and built
 * from the structured shares, so the count is the shares left unlisted.
 */
export function composeGroupHandBackReason(input: {
  totalCents: number;
  shares: ReadonlyArray<Pick<Share, "name" | "cents">>;
  supplementary: boolean;
  format: ClubFormat;
}): string {
  const total = formatCents(input.totalCents, input.format);
  const lead = "Group cancelled by its organiser - paid by Internet Banking.";
  const head = input.supplementary
    ? `${lead} A joiner's refund was recorded after the group's repayment task was closed: repay the organiser ${total} by bank transfer. Joiners' shares: `
    : `${lead} Repay the organiser ${total} by bank transfer. Joiners' shares: `;
  const labels = input.shares.map((share) => `${share.name} ${formatCents(share.cents, input.format)}`);
  for (let listed = labels.length; listed >= 0; listed -= 1) {
    const hidden = labels.length - listed;
    const tail = hidden > 0 ? ` … and ${hidden} more (see each joiner's booking).` : ".";
    const reason = `${head}${labels.slice(0, listed).join(", ")}${tail}`;
    if (reason.length <= MANUAL_REFUND_TASK_REASON_MAX) return reason;
  }
  return head.slice(0, MANUAL_REFUND_TASK_REASON_MAX);
}

const OWNER_NAME_SELECT = Prisma.validator<Prisma.BookingSelect>()({
  member: { select: { firstName: true, lastName: true } },
  organisation: { select: { name: true, email: true } },
});

function ownerName(booking: Prisma.BookingGetPayload<{ select: typeof OWNER_NAME_SELECT }>): string {
  const { firstName, lastName } = bookingOwner(booking).member;
  return [firstName, lastName].filter(Boolean).join(" ");
}

/**
 * Book one joiner's share on the organiser's hand-back, inside that joiner's
 * claim transaction and after its `lock(1)`. Returns the task it created or
 * updated, or null when nothing more is owed.
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

  const tasks = await tx.manualRefundTask.findMany({
    where: groupOrganiserHandBackTasksWhere(input.settlementId),
    select: { id: true, occurrenceKey: true, status: true, amountCents: true, reviewContext: true },
  });
  const owed = await joinersOwed(tx, input, tasks);
  const owedCents = [...owed.values()].reduce((sum, share) => sum + share.cents, 0);
  const mainKey = groupOrganiserHandBackOccurrenceKey(input.settlementId);
  const main = tasks.find((task) => task.occurrenceKey === mainKey);

  if (!main || main.status === ManualRefundTaskStatus.OPEN) {
    // The open task holds everything owed less what closed group tasks repaid.
    const repaidCents = tasks
      .filter((task) => task.status !== ManualRefundTaskStatus.OPEN)
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    const amountCents = owedCents - repaidCents;
    if (amountCents <= 0) return null;
    const shares = [...owed.values()];
    const data = {
      amountCents,
      raisedAmountCents: amountCents,
      reason: composeGroupHandBackReason({ totalCents: amountCents, shares, supplementary: false, format: input.format }),
      // Growing keeps the alert's record and lease, read fresh under this claim's lock(1).
      reviewContext: sharesContext(input.settlementId, shares, main ? alertRecordOf(main.reviewContext) : {}),
    };
    if (!main) {
      const created = await tx.manualRefundTask.create({
        data: { ...data, bookingId: input.organiserBookingId, kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK, occurrenceKey: mainKey },
        select: { id: true },
      });
      return { id: created.id, amountCents, created: true };
    }
    const updated = await tx.manualRefundTask.updateMany({
      where: { id: main.id, status: ManualRefundTaskStatus.OPEN },
      data,
    });
    if (updated.count === 1) return { id: main.id, amountCents, created: false };
  }

  // The settlement's task was closed before this share was booked: what no
  // group task covers yet goes on a task of its own, keyed by this joiner.
  const supplementaryKey = groupOrganiserHandBackOccurrenceKey(input.settlementId, input.claimedChildId);
  if (tasks.some((task) => task.occurrenceKey === supplementaryKey)) return null;
  const coveredCents = tasks.reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
  const amountCents = owedCents - coveredCents;
  if (amountCents <= 0) return null;
  const recorded = new Set(tasks.flatMap((task) => readGroupOrganiserHandBackShares(task.reviewContext)?.shares.map((share) => share.bookingId) ?? []));
  const shares = [...owed.values()].filter((share) => !recorded.has(share.bookingId));
  const created = await tx.manualRefundTask.create({
    data: {
      bookingId: input.organiserBookingId,
      amountCents,
      raisedAmountCents: amountCents,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: supplementaryKey,
      reason: composeGroupHandBackReason({ totalCents: amountCents, shares, supplementary: true, format: input.format }),
      reviewContext: sharesContext(input.settlementId, shares),
    },
    select: { id: true },
  });
  return { id: created.id, amountCents, created: true };
}

/**
 * Every joiner the organiser is owed for, by booking: those the ledger proves
 * this settlement refunded (its refund line; no `deletedAt` filter, because the
 * line is the proof), those a group task already records, and this claim's.
 */
async function joinersOwed(
  tx: Prisma.TransactionClient,
  input: { settlementId: string; plan: ReadonlyMap<string, number>; claimedChildId: string },
  tasks: ReadonlyArray<{ reviewContext: unknown }>,
): Promise<Map<string, Share>> {
  const plannedIds = [...input.plan].filter(([, cents]) => cents > 0).map(([id]) => id);
  const lines = await tx.bookingLedgerLine.findMany({
    where: { postingKey: { in: plannedIds.map((id) => groupSettlementRefundKey(input.settlementId, id)) } },
    select: { bookingId: true, amountCents: true },
  });
  const ledgerCents = new Map<string, number>();
  for (const line of lines) ledgerCents.set(line.bookingId, (ledgerCents.get(line.bookingId) ?? 0) + Math.abs(line.amountCents));

  const owed = new Map<string, Share>();
  for (const task of tasks) {
    for (const share of readGroupOrganiserHandBackShares(task.reviewContext)?.shares ?? []) owed.set(share.bookingId, share);
  }
  const unnamed = [...new Set([...ledgerCents.keys(), input.claimedChildId])].filter((id) => !owed.has(id));
  const names = unnamed.length
    ? await tx.booking.findMany({ where: { id: { in: unnamed } }, select: { id: true, ...OWNER_NAME_SELECT } })
    : [];
  const nameOf = new Map(names.map((booking) => [booking.id, ownerName(booking)]));
  for (const [bookingId, cents] of ledgerCents) {
    const known = owed.get(bookingId);
    owed.set(bookingId, { bookingId, name: known?.name ?? nameOf.get(bookingId) ?? "a joiner", cents });
  }
  if (!owed.has(input.claimedChildId)) {
    owed.set(input.claimedChildId, {
      bookingId: input.claimedChildId,
      name: nameOf.get(input.claimedChildId) ?? "a joiner",
      cents: input.plan.get(input.claimedChildId) ?? 0,
    });
  }
  return new Map([...owed].sort(([a], [b]) => a.localeCompare(b)));
}

type AlertRecord = Pick<GroupOrganiserHandBackShares, "alertSentAt" | "alertClaimedAt">;

function alertRecordOf(reviewContext: unknown): AlertRecord {
  const { alertSentAt, alertClaimedAt } = readGroupOrganiserHandBackShares(reviewContext) ?? {};
  return { ...(alertSentAt ? { alertSentAt } : {}), ...(alertClaimedAt ? { alertClaimedAt } : {}) };
}

function sharesContext(settlementId: string, shares: ReadonlyArray<Share>, alert: AlertRecord = {}): Prisma.InputJsonValue {
  const groupOrganiserHandBack: GroupOrganiserHandBackShares = { settlementId, shares: [...shares], ...alert };
  return { groupOrganiserHandBack } as unknown as Prisma.InputJsonValue;
}

/** How long a run's claim on an alert stands before another run may send it (a run that died mid-send). */
const ALERT_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * #4042: the finance alert for every OPEN organiser hand-back of this
 * settlement whose alert has not gone out - the cash cancel's "Manual refund
 * needed" email in its group wording, with the task's amount and reason read
 * when it is claimed. Run once the children loop ends (the reaper's resumed
 * run included), and by the reaper's own task-keyed sweep
 * (`resendUnsentGroupOrganiserHandBackAlerts`), always outside a transaction.
 *
 * AT MOST ONCE, ACROSS RUNS AND REPLICAS. A run first CLAIMS the alert: under
 * `lock(1)` it re-reads the task and writes a lease (`alertClaimedAt`), and
 * only when the task is still OPEN, unsent and unleased (or its lease has
 * expired). Only the run that won the claim sends, after its transaction
 * commits. It then records the send (`alertSentAt`, lease cleared) under the
 * same lock with a re-read; a send that reached nobody ("undelivered") gives
 * the lease back, so a later sweep retries; one that threw keeps the lease
 * until it expires. Every write to the record - this claim, its release, the
 * send's record and a claim's growth of the task - runs under `lock(1)` and
 * re-reads first, so none drops another's fields. Each task is handled on its
 * own, so one failure never stops the rest. Best-effort: never throws.
 */
export async function alertUnsentGroupOrganiserHandBacks(input: {
  settlementId: string;
  organiserBookingId: string;
  format: ClubFormat;
}): Promise<number> {
  let sent = 0;
  try {
    const tasks = await prisma.manualRefundTask.findMany({
      where: { ...groupOrganiserHandBackTasksWhere(input.settlementId), status: ManualRefundTaskStatus.OPEN },
      select: { id: true, reviewContext: true },
    });
    const unsent = tasks.filter((task) => !alertRecordOf(task.reviewContext).alertSentAt);
    if (unsent.length === 0) return 0;
    const organiserBooking = await prisma.booking.findUniqueOrThrow({
      where: { id: input.organiserBookingId },
      select: { checkIn: true, checkOut: true, ...OWNER_NAME_SELECT },
    });
    for (const { id: taskId } of unsent) {
      try {
        const claimedAt = new Date().toISOString();
        const claimed = await updateGroupHandBackAlertRecord(taskId, (record, task) => {
          const leased = record.alertClaimedAt && Date.parse(record.alertClaimedAt) > Date.parse(claimedAt) - ALERT_CLAIM_LEASE_MS;
          return task.status !== ManualRefundTaskStatus.OPEN || record.alertSentAt || leased ? null : { alertClaimedAt: claimedAt };
        });
        if (!claimed) continue;
        const outcome = await sendAdminManualRefundTaskAlert(
          {
            memberName: ownerName(organiserBooking),
            checkIn: organiserBooking.checkIn,
            checkOut: organiserBooking.checkOut,
            refundAmountCents: claimed.amountCents ?? 0,
            bookingId: input.organiserBookingId,
            reason: claimed.reason,
            situation: "group-organiser-internet-banking",
          },
          input.format,
        );
        if (outcome === "undelivered") {
          // Reached nobody: give the lease back (only if it is still ours), so a later sweep retries.
          await updateGroupHandBackAlertRecord(taskId, (record) => (record.alertClaimedAt === claimedAt ? {} : null));
          continue;
        }
        sent += 1;
        try {
          await updateGroupHandBackAlertRecord(taskId, () => ({ alertSentAt: new Date().toISOString() }));
        } catch (err) {
          logger.error({ err, manualRefundTaskId: taskId }, "Sent a group organiser's hand-back alert but could not record it; its lease holds it from being resent until it expires");
        }
      } catch (err) {
        logger.error({ err, manualRefundTaskId: taskId, settlementId: input.settlementId }, "Failed to alert admins about a group organiser's hand-back task; a later sweep retries");
      }
    }
  } catch (err) {
    logger.error(
      { err, organiserBookingId: input.organiserBookingId, settlementId: input.settlementId },
      "Failed to alert admins about a group organiser's hand-back task; a later sweep retries",
    );
  }
  return sent;
}

/**
 * THE one writer of a group hand-back's alert record outside the claim that
 * grows the task: a short transaction that takes `lock(1)` first (the key every
 * group-cancel claim holds when it rewrites `reviewContext`), re-reads the task,
 * and writes `next(record)` over the fresh shares - the lease (`alertClaimedAt`)
 * cleared whenever `next` does not set it. `next` returning null writes nothing
 * and returns null; otherwise the task's amount and reason as they stood.
 */
async function updateGroupHandBackAlertRecord(
  taskId: string,
  next: (record: AlertRecord, task: { status: ManualRefundTaskStatus }) => AlertRecord | null,
): Promise<{ amountCents: number | null; reason: string } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const task = await tx.manualRefundTask.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true, amountCents: true, reason: true, reviewContext: true },
    });
    const shares = readGroupOrganiserHandBackShares(task.reviewContext);
    if (!shares) return null;
    const current = alertRecordOf(task.reviewContext);
    const record = next(current, task);
    if (!record) return null;
    // The send's record survives every write; the lease survives none but the claim that sets it.
    const alertSentAt = record.alertSentAt ?? current.alertSentAt;
    await tx.manualRefundTask.update({
      where: { id: taskId },
      data: { reviewContext: sharesContext(shares.settlementId, shares.shares, { ...(alertSentAt ? { alertSentAt } : {}), ...(record.alertClaimedAt ? { alertClaimedAt: record.alertClaimedAt } : {}) }) },
    });
    return { amountCents: task.amountCents, reason: task.reason };
  });
}

/**
 * #4042: the reaper's task-keyed retry. The cancel's own run (and the reaper's
 * resume, which only re-drives a group with a joiner still active) is the
 * ordinary sender; a run that died or reached nobody after the LAST claim has
 * nothing to re-drive it. So every OPEN group hand-back older than the grace,
 * with no alert sent, is swept here through the same claim. Returns how many
 * alerts went out.
 */
export async function resendUnsentGroupOrganiserHandBackAlerts(cutoff: Date, format: ClubFormat): Promise<number> {
  const tasks = await prisma.manualRefundTask.findMany({
    // The key prefix alone marks a group organiser's hand-back; no other writer sets it.
    where: {
      status: ManualRefundTaskStatus.OPEN,
      occurrenceKey: { startsWith: GROUP_ORGANISER_HAND_BACK_KEY_PREFIX },
      createdAt: { lt: cutoff },
    },
    select: { bookingId: true, reviewContext: true },
  });
  const settlements = new Map<string, string>();
  for (const task of tasks) {
    const shares = readGroupOrganiserHandBackShares(task.reviewContext);
    if (shares && !shares.alertSentAt) settlements.set(shares.settlementId, task.bookingId);
  }
  let sent = 0;
  for (const [settlementId, organiserBookingId] of settlements) {
    sent += await alertUnsentGroupOrganiserHandBacks({ settlementId, organiserBookingId, format });
  }
  return sent;
}
