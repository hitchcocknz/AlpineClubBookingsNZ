import type { Prisma } from "@prisma/client";

import { cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import { closeKeysOf } from "@/lib/manual-refund-task-settlement-rules";
import { CARD_REFUND_OPERATION_WHERE, cardRefundResendsByRefund } from "@/lib/open-card-refund-owed";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/**
 * #4312 rounds 5 and 6 (#4104, `INV-ADDPAY-045`): A CARD REFUND SENT AGAIN FOR
 * ONE STRIPE FAILED LATER IS ANSWERED BY THE FAILED REFUND'S OWN NOTE.
 *
 * A refund Stripe accepted and failed later keeps the note it took while it
 * counted, and #4104 meant that note to answer the money once it goes back -
 * so the refund sent again in its place is owed no second note. Which refund
 * that is comes from the owed figure's own attribution
 * (`cardRefundResendsByRefund`): a refund filling a slice that owes a failure
 * - a row of its own's key, a re-planned slice's `failedRefundIds` - answers
 * it. A late capture's refunds are its capture's note's to size
 * (`planLateCaptureCardNotes`).
 *
 * THE CHAIN (round 6). A re-send Stripe failed too took no note of its own -
 * the first failure's note answered it - so whatever answers it inherits what
 * it answered: the failed refunds it answered while it counted (read as the
 * payment stood when it failed), and theirs, each once. The walk follows
 * time - a refund answers only failures the ledger saw before Stripe made it -
 * so it ends.
 *
 * Read by a card refund's note share (`readCardRefundNoteShare`), so its
 * enqueue and its execution size it alike, and - whether it is noted on its
 * own record at all (`ownNoted`) - by the recovery replay and
 * `charge.refunded` alike (`answersOwnNotedFailure`): one rule, two writers.
 */
type FailedRefundAnswer = {
  /** The failed refunds this refund was sent again for, the chain behind them included. */
  failedRefundIds: string[];
  /** Whether any of them was asked for on its own record (it has a note row of its own, in any status). */
  ownNoted: boolean;
  /** What their own notes cover: what already answers this refund in Xero. */
  coverCents: number;
};

const NONE: FailedRefundAnswer = { failedRefundIds: [], ownNoted: false, coverCents: 0 };

type AnswerReader = Pick<
  Prisma.TransactionClient,
  "payment" | "paymentRecoveryOperation" | "paymentRefund" | "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation"
>;

/** The failed refunds `stripeRefundId` was sent again for on this payment, the chain behind them, and what their own notes cover. */
export async function readFailedRefundsAnsweredBy(db: AnswerReader, paymentId: string, stripeRefundId: string): Promise<FailedRefundAnswer> {
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true, amountCents: true, refundedAmountCents: true } });
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId },
    select: { stripeRefundId: true, paymentTransactionId: true, stripePaymentIntentId: true, amountCents: true, status: true, createdAt: true, updatedAt: true, stripeCreatedAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // one order for refunds recorded in the same instant
  });
  const refund = refunds.find((each) => each.stripeRefundId === stripeRefundId);
  if (!payment || !refund?.paymentTransactionId || !isRecordedRefundStatus(refund.status)) return NONE;
  if (refund.stripePaymentIntentId && (await findLateCapturePaymentIntents([refund.stripePaymentIntentId], db)).size > 0) return NONE;
  const recoveryOperations = await db.paymentRecoveryOperation.findMany({
    where: { paymentId, ...CARD_REFUND_OPERATION_WHERE },
    select: { id: true, type: true, status: true, idempotencyKey: true, amountCents: true, allocationPlan: true, paymentTransactionId: true, createdAt: true, succeededAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const closes = await db.manualRefundTask.findMany({
    where: { paymentId, occurrenceKey: { in: recoveryOperations.flatMap((operation) => closeKeysOf(operation.id)) } },
    select: { occurrenceKey: true },
  });
  const closed = new Set(closes.map((task) => task.occurrenceKey));
  const paidAnotherWay = new Set(recoveryOperations.filter((operation) => closeKeysOf(operation.id).some((key) => closed.has(key))).map((operation) => operation.id));
  // A failed refund row is not written again once it failed, so its `updatedAt` is when the ledger saw it fail.
  const failedAt = new Map(refunds.filter((each) => !isRecordedRefundStatus(each.status)).map((each) => [each.stripeRefundId, each.updatedAt]));
  const ledger = { ...payment, recoveryOperations, refunds };
  const options = { failedAt: (id: string) => failedAt.get(id) ?? null, paidAnotherWay };

  const chain = new Set<string>();
  const toWalk = [...(cardRefundResendsByRefund(ledger, options).get(stripeRefundId) ?? [])];
  for (let failed = toWalk.shift(); failed !== undefined; failed = toWalk.shift()) {
    if (failed === stripeRefundId || chain.has(failed)) continue;
    chain.add(failed);
    toWalk.push(...(cardRefundResendsByRefund(ledger, { ...options, asOfFailureOf: failed }).get(failed) ?? []));
  }
  if (chain.size === 0) return NONE;
  let ownNoted = false;
  let coverCents = 0;
  for (const id of chain) {
    const rowsWhere = cardRefundNoteRowsWhere(paymentId, id);
    ownNoted ||= (await db.xeroSyncOperation.count({ where: rowsWhere })) > 0;
    coverCents += await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  }
  return { failedRefundIds: [...chain], ownNoted, coverCents };
}
