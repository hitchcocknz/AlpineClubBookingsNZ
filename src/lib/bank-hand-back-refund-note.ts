import type { Prisma } from "@prisma/client";

import { asRecord, readString } from "@/lib/xero-json";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";
import { findCanonicalPaymentRefundCreditNote } from "@/lib/xero-sync";

/**
 * #4287 (owner decision 22 Oct 2026, `INV-ADDPAY-043`): DOES A CANCELLATION
 * HAND-BACK'S XERO NOTE STAND ON ITS OWN RECORD?
 *
 * A bank-transfer payment keeps one canonical refund note, for its first
 * refund. Before #4287 every later hand-back completed on it was taken as a
 * replay of that note and raised nothing ("already linked"), so Xero showed
 * less credit than the club paid back. Now a hand-back's note is keyed and
 * sized on its own task - the per-record route a "Paid another way" close, a
 * card refund shortfall and a re-confirmed bank refund already take
 * (`paidAnotherWayTaskId`, `readPaidAnotherWayCloseShare`) - whenever the
 * payment-wide figure cannot answer it:
 *
 * - the payment already has its canonical refund note, linked
 *   (`findCanonicalPaymentRefundCreditNote`) or ON ITS WAY: a canonical create
 *   row still PENDING, RUNNING or FAILED. A row on its way is not linked yet,
 *   so without it two hand-backs completed close together would both take the
 *   canonical route, and the second would be closed as covered by the first's
 *   note when it ran. The completion holds the Payment row lock
 *   (`applyLocalRefundAllocation`, #4217) before this read, so a second
 *   completion reads after the first commits its row;
 * - or the payment has card refund rows. Its refund-note cash is then read
 *   from them (`resolveStripeCashRefundEvidence`'s provider ledger), which
 *   leaves the hand-back's bank cash out, so a canonical note sized against
 *   that cash would floor at nothing.
 *
 * Otherwise this hand-back's note IS the canonical one, raised as before.
 * Only a completion asks, at the moment it records the refund: nothing re-asks
 * for a hand-back already completed, so no refund made before #4287 is ever
 * given a note of its own (owner, 22 Oct 2026). A read only - no lock, no write.
 */
export async function cancellationHandBackNotedOnItsOwnRecord(
  store: Prisma.TransactionClient,
  paymentId: string,
  handBackTaskId: string,
): Promise<boolean> {
  if (await findCanonicalPaymentRefundCreditNote(paymentId, store)) return true;
  if ((await store.paymentRefund.count({ where: { paymentId } })) > 0) return true;
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: { in: ["PENDING", "RUNNING", "FAILED"] },
      OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }],
    },
    select: { requestPayload: true },
  });
  return (rows ?? []).some((row) => isCanonicalRefundNoteRowOfAnother(row.requestPayload, handBackTaskId));
}

/**
 * A refund-note create row that would raise the payment's canonical note: a
 * refund note that names no record of its own (a review, a close or other
 * per-record task, a refund request) and is not stamped per refund - and is
 * not this hand-back's own.
 */
function isCanonicalRefundNoteRowOfAnother(requestPayload: unknown, handBackTaskId: string): boolean {
  const recorded = parsePaymentCreditNoteRetryInput({ requestPayload });
  if (!recorded || recorded.kind !== "refund") return false;
  const payload = asRecord(requestPayload);
  if (recorded.refundRequestId || recorded.paidAnotherWayTaskId || readString(payload?.reviewTaskId) || payload?.perDelta === true) {
    return false;
  }
  return recorded.handBackTaskId !== handBackTaskId;
}
