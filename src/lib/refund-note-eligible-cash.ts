/**
 * THE CASH A REFUND CREDIT NOTE MAY ANSWER (#3635 round-3 R1, `INV-PAY-110`).
 *
 * The one figure every refund-note sizing and gap reads: the enqueue's cap
 * (`enqueueXeroRefundCreditNoteOperation`), the note's execution-time cap
 * (`createXeroCreditNote`), the refund-gap reader behind the self-heal list and
 * the booking page (`readRefundCreditNoteGap`), the hardening report's
 * over-coverage count, and the refund-note link-repair script's coverage
 * target (`xero-refund-note-link-repair.ts`, #3635 C3). It is the payment's provider-backed CASH refund evidence
 * (`resolveStripeCashRefundEvidence`, #2902) LESS the refunds of late captures
 * the app never recorded in Xero.
 *
 * WHY. A late capture on a cancelled booking is a receipt Xero does not hold
 * until the app records it (`readLateCaptureXeroReceipt`): refunded before
 * then - on a treasurer's approval, after a withdrawal, in the dashboard and
 * then closed, or automatically by the webhook - it deliberately gets no note,
 * because the note's Stripe-account refund payment would take out money that
 * never went in. Counted as ordinary cash, that deliberate gap read as a
 * missing note, and the nightly self-heal raised it 24 hours later against the
 * booking's cleared pre-cancel invoice. A receipt resolved by hand is excluded
 * too: its refunds are recorded by hand, and the repair tool says so.
 *
 * Refund rows are matched to their capture by `PaymentRefund.stripePaymentIntentId`;
 * which intents are late captures is `findLateCapturePaymentIntents`, plus
 * (#4170) any capture the primary late-capture handler marked as its own write
 * (`CANCELLED_BOOKING_LATE_CAPTURE_REASON`) while it has no record row yet. A
 * pre-ledger payment (no `PaymentRefund` rows) predates late-capture holds and
 * is left to the evidence's legacy rule.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { CANCELLED_BOOKING_LATE_CAPTURE_REASON } from "@/lib/cancellation-settled-money";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import {
  resolveStripeCashRefundEvidence,
  type StripeCashRefundEvidence,
} from "@/lib/stripe-cash-refund-evidence";
import {
  findLateCapturePaymentIntents,
  hasXeroReceiptForLateCapture,
} from "@/lib/late-capture-xero-receipt";

export interface RefundNoteEligibleCash {
  /** The payment's cash refund evidence, as `resolveStripeCashRefundEvidence` reads it. */
  evidence: StripeCashRefundEvidence;
  /** Cash refunds of late captures the app never recorded in Xero: no note answers them. */
  lateCaptureExcludedCents: number;
  /** What refund credit notes on this payment may cover. Never negative. */
  eligibleCashCents: number;
}

export async function resolveRefundNoteEligibleCash(
  payment: { id: string; bookingId: string; refundedAmountCents: number },
  db: Prisma.TransactionClient = prisma,
): Promise<RefundNoteEligibleCash> {
  const evidence = await resolveStripeCashRefundEvidence(payment, db);
  if (evidence.source !== "provider-ledger" || evidence.cashRefundCents <= 0) {
    return { evidence, lateCaptureExcludedCents: 0, eligibleCashCents: evidence.cashRefundCents };
  }
  const centsByIntent = await readRecordedRefundCentsByIntent(payment.id, db);
  const intents = [...centsByIntent.keys()];
  const lateIntents = await findLateCapturePaymentIntents(intents, db);
  // #4170: a capture the late-capture handler marked as its own is a late
  // capture before its record row exists too (lost, or refunded outside the app).
  for (const intent of await findMarkedLateCaptureIntents(intents, db)) lateIntents.add(intent);
  let lateCaptureExcludedCents = 0;
  for (const intent of lateIntents) {
    if (!(await hasXeroReceiptForLateCapture(intent, db))) {
      lateCaptureExcludedCents += centsByIntent.get(intent) ?? 0;
    }
  }
  return {
    evidence,
    lateCaptureExcludedCents,
    eligibleCashCents: Math.max(0, evidence.cashRefundCents - lateCaptureExcludedCents),
  };
}

/**
 * The payment's recorded refunds, summed per payment intent - which capture
 * each refunded, by `PaymentRefund.stripePaymentIntentId`. Shared with the
 * nightly lost-record check (#4149), which asks about exactly these intents.
 */
export async function readRecordedRefundCentsByIntent(
  paymentId: string,
  db: Pick<Prisma.TransactionClient, "paymentRefund"> = prisma,
): Promise<Map<string, number>> {
  const rows = await db.paymentRefund.findMany({
    where: { paymentId, stripePaymentIntentId: { not: null } },
    select: { stripePaymentIntentId: true, amountCents: true, status: true },
  });
  const centsByIntent = new Map<string, number>();
  for (const row of rows ?? []) {
    if (!row.stripePaymentIntentId || !isRecordedRefundStatus(row.status)) continue;
    centsByIntent.set(
      row.stripePaymentIntentId,
      (centsByIntent.get(row.stripePaymentIntentId) ?? 0) + Math.max(0, row.amountCents),
    );
  }
  return centsByIntent;
}

/** The intents among these whose capture the primary late-capture handler wrote itself (#3639's marker). */
async function findMarkedLateCaptureIntents(
  paymentIntentIds: readonly string[],
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
): Promise<string[]> {
  if (paymentIntentIds.length === 0) return [];
  const rows = await db.paymentTransaction.findMany({
    where: { stripePaymentIntentId: { in: [...paymentIntentIds] }, reason: CANCELLED_BOOKING_LATE_CAPTURE_REASON },
    // The ledger's order (#4132, INV-PAY-133), though only membership is read.
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true },
  });
  return (rows ?? []).map((row) => row.stripePaymentIntentId).filter((intent): intent is string => Boolean(intent));
}
