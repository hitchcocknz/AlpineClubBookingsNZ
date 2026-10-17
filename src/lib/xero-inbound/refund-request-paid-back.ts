import type { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";
import { REFUND_REQUEST_HAND_BACK_KEY_PREFIX } from "@/lib/manual-refund-task-settlement-rules";
import { prisma } from "@/lib/prisma";

/**
 * #4215 (`INV-PAY-118`, `INV-ADDPAY-021`): a refund request's hand-back the
 * treasurer marked paid back, as a where fragment - the kind and key prefix
 * `isRefundRequestHandBackTask` asks, COMPLETED. Its completion moved the
 * payment's `refundedAmountCents` by its `amountCents` (the `local-allocation`
 * route) and queued the request's own note for that amount.
 */
export const COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind,
  status: "COMPLETED" satisfies ManualRefundTaskStatus,
  occurrenceKey: { startsWith: REFUND_REQUEST_HAND_BACK_KEY_PREFIX },
} as const;

/**
 * The cash each payment's refund requests were paid back, as their completions
 * recorded it, for the inbound repair that rebuilds a refunded total from the
 * payment's Xero notes. Never read from a request's own note
 * (`REFUND_REQUEST_CREDIT_NOTE`), which may still be queued or voided (#4195)
 * while the cash stays paid back, and never attributed to the canonical note.
 */
export async function readRefundRequestPaidBackCentsByPaymentId(
  paymentIds: string[],
): Promise<Map<string, number>> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { paymentId: { in: paymentIds }, ...COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE },
    select: { paymentId: true, amountCents: true },
  });
  const centsByPaymentId = new Map<string, number>();
  for (const task of tasks) {
    if (task.paymentId === null) continue;
    centsByPaymentId.set(task.paymentId, (centsByPaymentId.get(task.paymentId) ?? 0) + Math.max(task.amountCents ?? 0, 0));
  }
  return centsByPaymentId;
}
