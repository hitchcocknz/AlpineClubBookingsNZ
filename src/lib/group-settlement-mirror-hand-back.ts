import "server-only";

import { PaymentStatus, type Prisma } from "@prisma/client";

import { groupChildHandBacksFromRows, mirrorPlanShareWritten } from "@/lib/booking-ledger-group-child-plan";
import { GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { assertGroupMirrorHandBackWithinUnpromisedCash } from "@/lib/edit-refund-hand-back";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";
import { mirrorPlanRefundedCents } from "@/lib/group-settlement-refund-plan";
import { isEditRefundHandBackTask, isRefundRequestHandBackTask } from "@/lib/manual-refund-task-settlement-rules";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";

/**
 * #3949 (`INV-PAY-136`; owner decisions on #3949, 15 and 21 Oct 2026): AN
 * EDIT'S OR AN APPROVED APPEAL'S BANK-TRANSFER REFUND ON A JOINER'S BOOKING THE
 * GROUP ORGANISER PAID FOR BY INTERNET BANKING.
 *
 * The organiser's one bank-transfer invoice settles every joiner, and the settle
 * gives each child a `SUCCEEDED`, `INTERNET_BANKING` payment mirror with NO
 * `PaymentTransaction` of its own (`group-settlement.ts`). An edit that lowers
 * such a child's price raises an edit refund hand-back (`INV-PAY-117`), and an
 * approved appeal a refund-request hand-back (`INV-PAY-118`). Both used to
 * complete through `applyLocalRefundAllocation`, which allocates against the
 * payment's captured transactions - none - and refused every amount as "more
 * than was ever captured", so the task could never be paid, and once the
 * child was cancelled it could not be dismissed either.
 *
 * The refund comes out of the organiser's group payment and goes back to the
 * organiser, the same pattern a card-paid group uses (#3653) and the IB group
 * cancel uses (#4042). Completing the task therefore records it the way the
 * group cancel records ITS refunds on a child: on the child's
 * `refundedAmountCents` mirror (`mirrorPlanRefundedCents`, REFUNDED or
 * PARTIALLY_REFUNDED), beside the hand-back's `BANK_REFUND` ledger line. The
 * group's `GroupBookingSettlement` is NOT touched: its status is what the
 * group cancel and its replay read to decide whether the settlement's own
 * refund is still to be made, and a bank transfer for one joiner is not that.
 *
 * Locks: none of its own. The completion already holds `lock(1)` for these two
 * keys (`resolveManualRefundTask#1`); the route takes the `Payment` row
 * (`lockPaymentForRefundedTotal`) next, before the cap read, so the cap and the
 * write see one figure (`INV-LOCK-002`: global, then the row).
 */

/** The route a completion takes for such a hand-back (`EditReviewSettlementRoute`'s member). */
export type GroupSettlementMirrorRoute = {
  kind: "group-settlement-mirror";
  /** The child's payment mirror, which the refund is recorded on. */
  paymentId: string;
  /** No edit-review anchor: the edit's own Xero note already corrected the invoice. */
  bookingModificationId: null;
  /** What goes back to the organiser by bank transfer. */
  refundCents: number;
  /** Nothing of it is applied credit: the organiser paid in money. */
  creditBackCents: 0;
};

type MirrorHandBackTask = {
  id: string;
  kind: string | null;
  occurrenceKey: string | null;
  paymentId: string | null;
  booking: {
    organiserSettled: boolean;
    parentBookingId: string | null;
    payment: { id: string; source: string } | null;
  };
};

/**
 * Is this an edit's or an approved appeal's hand-back on a joiner's booking the
 * organiser paid for by internet banking, raised on that booking's own payment?
 * Pure; `chooseGroupSettlementMirrorRoute` adds the one fact it cannot see
 * (that no transaction backs the payment).
 */
export function isGroupSettlementMirrorHandBack(task: MirrorHandBackTask): boolean {
  return (
    (isEditRefundHandBackTask(task) || isRefundRequestHandBackTask(task)) &&
    task.paymentId !== null &&
    task.booking.payment?.id === task.paymentId &&
    paidByOrganiserInternetBanking(task.booking)
  );
}

/**
 * The route, or null when the task is not one of these (the caller then keeps
 * its ordinary route). Before the claim, inside the completion's transaction:
 * a refusal here leaves the task OPEN.
 *
 * A child payment that DOES carry a `PaymentTransaction` is left on the ledger
 * route: there the transactions are the record, and a mirror written beside
 * them would be undone by the next aggregate reconcile.
 */
export async function chooseGroupSettlementMirrorRoute({
  task,
  amountCents,
  store,
}: {
  task: MirrorHandBackTask;
  amountCents: number;
  store: Prisma.TransactionClient;
}): Promise<GroupSettlementMirrorRoute | null> {
  if (!isGroupSettlementMirrorHandBack(task) || task.paymentId === null) return null;
  const paymentId = task.paymentId;
  if ((await store.paymentTransaction.count({ where: { paymentId } })) > 0) return null;
  await lockPaymentForRefundedTotal(store, paymentId);
  await assertGroupMirrorHandBackWithinUnpromisedCash(store, { paymentId, taskId: task.id, amountCents });
  return { kind: "group-settlement-mirror", paymentId, bookingModificationId: null, refundCents: amountCents, creditBackCents: 0 };
}

/**
 * Record the refund on the child's mirror, after the claim, holding the
 * `Payment` row the route took. Refused, never clamped, past what the payment
 * still holds: the throw rolls the claim back and the task stays OPEN.
 */
export async function applyGroupSettlementMirrorRefund({
  route,
  store,
}: {
  route: GroupSettlementMirrorRoute;
  store: Prisma.TransactionClient;
}): Promise<void> {
  await lockPaymentForRefundedTotal(store, route.paymentId);
  const payment = await store.payment.findUniqueOrThrow({
    where: { id: route.paymentId },
    select: { amountCents: true, refundedAmountCents: true },
  });
  if (route.refundCents <= 0 || payment.refundedAmountCents + route.refundCents > payment.amountCents) {
    throw new ManualBookingPaymentError(GROUP_MIRROR_HAND_BACK_EXCEEDS_CASH_MESSAGE, 400);
  }
  const nextRefunded = mirrorPlanRefundedCents(payment, route.refundCents);
  await store.payment.update({
    where: { id: route.paymentId },
    data: {
      refundedAmountCents: nextRefunded,
      status: nextRefunded >= payment.amountCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
    },
  });
}

/**
 * #3949 (`INV-PAY-136`): A GROUP CHILD'S MIRROR, AS THE ORGANISER CANCEL'S
 * RECOVERY REPLAY READS IT. Before #3949 only the cancel moved such a child's
 * `refundedAmountCents`, so the replay read "zero" as "the plan's share is not
 * written yet". A paid-back edit or appeal hand-back now moves it too, so the
 * replay asks `mirrorPlanShareWritten` instead - the figure net of what those
 * hand-backs moved - and asks it holding the `Payment` row, which the
 * hand-back's completion takes before its claim: the two never interleave, so
 * the plan's share is neither skipped nor counted twice.
 */
export async function readGroupChildMirrorForPlanReplay(
  tx: Prisma.TransactionClient,
  paymentId: string,
): Promise<{ amountCents: number; refundedAmountCents: number; planShareWritten: boolean }> {
  await lockPaymentForRefundedTotal(tx, paymentId);
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { amountCents: true, refundedAmountCents: true },
  });
  const paidBack = await tx.manualRefundTask.findMany({
    where: { paymentId, kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED" },
    select: { kind: true, status: true, occurrenceKey: true, paymentId: true, amountCents: true },
  });
  return {
    ...payment,
    planShareWritten: mirrorPlanShareWritten(payment.refundedAmountCents, groupChildHandBacksFromRows(paymentId, paidBack)),
  };
}
