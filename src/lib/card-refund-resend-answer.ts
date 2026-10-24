import type { Prisma } from "@prisma/client";

import { cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import { CARD_REFUND_OPERATION_WHERE, cardRefundFailuresAnsweredBy } from "@/lib/open-card-refund-owed";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #4312 round 7 (#4104, `INV-ADDPAY-045`): A CARD REFUND SENT AGAIN FOR ONE
 * STRIPE FAILED LATER IS ANSWERED BY THE FAILED REFUND'S OWN NOTE.
 *
 * A refund Stripe accepted and failed later keeps the note it took while it
 * counted, and #4104 meant that note to answer the money once it goes back -
 * so the refund the recovery replay sends in its place is owed only what that
 * note does not cover. Which failures a refund answers is the replay's own
 * record and nothing else (`cardRefundFailuresAnsweredBy`): the slice it sent
 * for them, marked with the refund Stripe made. A refund no slice is marked
 * with - a Stripe dashboard refund - answers nothing and is noted in full. A
 * late capture's refunds are its capture's note's to size
 * (`planLateCaptureCardNotes`), so they answer nothing here.
 *
 * Read by a card refund's note share (`readCardRefundNoteShare`), so its
 * enqueue and its execution size it alike, and - whether it is a re-send at
 * all (`paired`) and noted on its own record (`ownNoted`) - by the recovery
 * replay and `charge.refunded` alike: one rule, two writers.
 */
export type FailedRefundAnswer = {
  /** The failed refunds this refund was sent again for, the chain behind them included. */
  failedRefundIds: string[];
  /** Whether any of them was asked for on its own record (it has a note row of its own, in any status). */
  ownNoted: boolean;
  /** What their own notes cover: what already answers this refund in Xero. */
  coverCents: number;
};

const NONE: FailedRefundAnswer = { failedRefundIds: [], ownNoted: false, coverCents: 0 };

type AnswerReader = Pick<Prisma.TransactionClient, "paymentRecoveryOperation" | "paymentRefund" | "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">;

/** The failed refunds `stripeRefundId` was sent again for on this payment, the chain behind them, and what their own notes cover. */
export async function readFailedRefundsAnsweredBy(db: AnswerReader, paymentId: string, stripeRefundId: string): Promise<FailedRefundAnswer> {
  const refund = await db.paymentRefund.findFirst({ where: { paymentId, stripeRefundId }, select: { status: true, stripePaymentIntentId: true } });
  if (!refund || !isRecordedRefundStatus(refund.status)) return NONE;
  if (refund.stripePaymentIntentId && (await findLateCapturePaymentIntents([refund.stripePaymentIntentId], db)).size > 0) return NONE;
  const operations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId, ...CARD_REFUND_OPERATION_WHERE },
    select: { idempotencyKey: true, allocationPlan: true },
  });
  const failedRefundIds = cardRefundFailuresAnsweredBy(operations, stripeRefundId);
  if (failedRefundIds.length === 0) return NONE;
  let ownNoted = false;
  let coverCents = 0;
  for (const id of failedRefundIds) {
    const rowsWhere = cardRefundNoteRowsWhere(paymentId, id);
    ownNoted ||= (await db.xeroSyncOperation.count({ where: rowsWhere })) > 0;
    coverCents += await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  }
  return { failedRefundIds, ownNoted, coverCents };
}
