import type { Prisma } from "@prisma/client";

import { cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import { closeKeysOf } from "@/lib/manual-refund-task-settlement-rules";
import { CARD_REFUND_OPERATION_WHERE, parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { cardRefundFailedLaterRefundId } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #4312 round 5 (#4104, `INV-ADDPAY-044`): A CARD REFUND SENT AGAIN FOR ONE
 * STRIPE FAILED LATER IS ANSWERED BY THE FAILED REFUND'S OWN NOTE.
 *
 * A refund Stripe accepted and failed later keeps the note it took while it
 * counted, and #4104 meant that note to answer the money once it goes back -
 * so the refund sent again in its place is owed no second note. #4104 records
 * which failures a recovery row sends again, and nothing else does: a row of
 * its own names the failed refund in its key (`card_refund_failed_later_<id>`),
 * and a slice an open row re-planned lists it (`failedRefundIds`). Neither the
 * refund row nor Stripe's metadata names the refund that answers it, so each
 * such slice is answered by the first refund recorded after its latest failure
 * was (a failed refund row is never written again, so its `updatedAt` is when
 * it failed) on the same charge for the same amount - a slice's every send asks
 * for exactly its amount on its own charge - or by the refund the slice is
 * marked made with. A refund made before the failure, failed or not, is never
 * its answer. Each refund answers one slice at most. A re-send that failed too
 * still takes the slice (its own failure has its own owner), and a row closed as
 * "Paid another way" sent nothing, so its slices take none: that close is sized
 * against the card note already (`failedLaterCardNoteCoverCents`). A late
 * capture's refunds are its capture's note's to size (`planLateCaptureCardNotes`).
 *
 * Read by a card refund's note share (`readCardRefundNoteShare`), so its
 * enqueue and its execution size it alike, and by `charge.refunded`, which
 * hands such a refund to its own record instead of the canonical delta.
 */
export type FailedRefundAnswer = {
  /** The failed refunds this refund was sent again for. */
  failedRefundIds: string[];
  /** Whether any of them was asked for on its own record (it has a note row of its own, in any status). */
  ownNoted: boolean;
  /** What their own notes cover: what already answers this refund in Xero. */
  coverCents: number;
};

const NONE: FailedRefundAnswer = { failedRefundIds: [], ownNoted: false, coverCents: 0 };

type AnswerReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "paymentRefund" | "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">;

type RefundRow = { stripeRefundId: string; paymentTransactionId: string | null; stripePaymentIntentId: string | null; amountCents: number; status: string; createdAt: Date; updatedAt: Date };

/** When the ledger recorded it, and (a refused row) when it failed: the database's one clock, never Stripe's. */
const recordedAt = (refund: RefundRow) => refund.createdAt.getTime();
const byRecorded = (a: RefundRow, b: RefundRow) => recordedAt(a) - recordedAt(b) || a.stripeRefundId.localeCompare(b.stripeRefundId);

/** The failed refunds `stripeRefundId` was sent again for on this payment, and what their own notes cover. */
export async function readFailedRefundsAnsweredBy(db: AnswerReader, paymentId: string, stripeRefundId: string): Promise<FailedRefundAnswer> {
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId },
    select: { stripeRefundId: true, paymentTransactionId: true, stripePaymentIntentId: true, amountCents: true, status: true, createdAt: true, updatedAt: true },
  });
  const refund = refunds.find((each) => each.stripeRefundId === stripeRefundId);
  if (!refund?.paymentTransactionId || !isRecordedRefundStatus(refund.status)) return NONE;
  if (refund.stripePaymentIntentId && (await findLateCapturePaymentIntents([refund.stripePaymentIntentId], db)).size > 0) return NONE;
  const rows = await db.paymentRecoveryOperation.findMany({
    where: { paymentId, ...CARD_REFUND_OPERATION_WHERE },
    select: { id: true, idempotencyKey: true, allocationPlan: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const closed = new Set(
    (await db.manualRefundTask.findMany({ where: { paymentId, occurrenceKey: { in: rows.flatMap((row) => closeKeysOf(row.id)) } }, select: { occurrenceKey: true } }))
      .map((task) => task.occurrenceKey),
  );
  const byId = new Map(refunds.map((each) => [each.stripeRefundId, each]));
  const ordered = [...refunds].sort(byRecorded);
  const taken = new Set<string>();
  const answered: string[] = [];
  for (const row of rows) {
    if (closeKeysOf(row.id).some((key) => closed.has(key))) continue;
    const ownedByKey = cardRefundFailedLaterRefundId(row.idempotencyKey);
    for (const slice of parseRefundAllocationPlan(row.allocationPlan) ?? []) {
      const failed = [...new Set([...(ownedByKey ? [ownedByKey] : []), ...(slice.failedRefundIds ?? [])])];
      if (failed.length === 0) continue;
      const failedAt = Math.max(...failed.map((id) => byId.get(id)?.updatedAt.getTime() ?? 0));
      const answer = slice.madeRefundId
        ? byId.get(slice.madeRefundId)
        : ordered.find((each) =>
            !taken.has(each.stripeRefundId) && !failed.includes(each.stripeRefundId) &&
            each.paymentTransactionId === slice.paymentTransactionId && each.amountCents === slice.amountCents && recordedAt(each) >= failedAt);
      if (!answer || taken.has(answer.stripeRefundId)) continue;
      taken.add(answer.stripeRefundId);
      if (answer.stripeRefundId === stripeRefundId) answered.push(...failed);
    }
  }
  if (answered.length === 0) return NONE;
  const failedRefundIds = [...new Set(answered)];
  let ownNoted = false;
  let coverCents = 0;
  for (const id of failedRefundIds) {
    const rowsWhere = cardRefundNoteRowsWhere(paymentId, id);
    ownNoted ||= (await db.xeroSyncOperation.count({ where: rowsWhere })) > 0;
    coverCents += await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  }
  return { failedRefundIds, ownNoted, coverCents };
}
