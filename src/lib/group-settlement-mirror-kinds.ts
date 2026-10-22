import { isEditRefundHandBackTask, isRefundRequestHandBackTask } from "@/lib/manual-refund-task-settlement-rules";

/**
 * #3949 (`INV-PAY-136`): THE HAND-BACKS THAT GO BACK TO THE GROUP ORGANISER on a
 * joiner's booking the organiser paid for by internet banking, by their kind and
 * key alone: an edit's refund (`INV-PAY-117`), an approved appeal's
 * (`INV-PAY-118`) and - owner decision, 22 Oct 2026 - the joiner's own
 * cancellation's, the ordinary keyless `CANCELLED_BOOKING_HAND_BACK` the paid
 * cancel raises (a part-payment review shares that kind but is never completed,
 * so never reaches a settlement route). Pure and client-safe: the completion's
 * route (`isGroupSettlementMirrorHandBack`) and the finance queue's payload ask
 * it, each beside `paidByOrganiserInternetBanking`.
 */
export function isGroupSettlementMirrorHandBackKind(task: {
  kind: string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    isEditRefundHandBackTask(task) ||
    isRefundRequestHandBackTask(task) ||
    (task.kind === "CANCELLED_BOOKING_HAND_BACK" && task.occurrenceKey === null)
  );
}
