import "server-only";

import type { PaymentSource } from "@prisma/client";

import { sizeCancelCardShortfall, sumHeadroomCents, type CancelCardRefundSplit } from "@/lib/cancel-card-refund-shortfall";
import { nonCardChargeHeadroom } from "@/lib/cancel-card-refund-shortfall-settle";
import { forcedCancelRefundMethod } from "@/lib/cancel-refund-method";
import { foldMirrorRefundIntoLedger } from "@/lib/mirror-refund-fold";
import { paidCancellationBranch } from "@/lib/paid-cancellation-event";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import {
  buildRefundAllocationSlices,
  legacyBackfillRows,
  loadPaymentWithTransactions,
  refundHeadroomIncrementCents,
  type PaymentStore,
} from "@/lib/payment-transactions";

/**
 * #4119 (`INV-PAY-129`): the card refund plan a card cancel would freeze right
 * now, and its split, WITHOUT writing. The claim's steps, each from its one
 * home, in its order, on an in-memory copy of the payment's ledger:
 *
 * 1. a partly refunded mirror's unattributed refund is folded onto the captured
 *    rows (`foldMirrorRefundIntoLedger`, capped by `refundHeadroomIncrementCents`);
 * 2. a pre-ledger payment's charges are read as its backfill would write them
 *    (`legacyBackfillRows`) - a GET must not write them, racing the cancel's own;
 * 3. the card plan is the newest-first Stripe slices (`buildRefundAllocationSlices`);
 * 4. the rest is split by the non-card charges' headroom (`nonCardChargeHeadroom`,
 *    `sizeCancelCardShortfall`).
 *
 * So the preview and the cancel differ only if the payment's records move in
 * between. Null when the plan carries the whole refund.
 */
export async function previewCancelCardRefundSplit(
  db: PaymentStore,
  params: { paymentId: string; refundAmountCents: number },
): Promise<CancelCardRefundSplit | null> {
  const payment = await loadPaymentWithTransactions(db, params.paymentId);
  if (!payment) throw new Error("Payment not found");
  const rows = payment.transactions.map((row) => ({ ...row }));
  const captured = () => rows.filter((row) => isCapturedTransactionStatus(row.status));
  await foldMirrorRefundIntoLedger(payment, captured, (row, cents) => {
    const taken = refundHeadroomIncrementCents(row, cents);
    row.refundedAmountCents += taken;
    return taken;
  });
  // A backfilled row is the newest; only the planned total is read here, and it does not depend on the order.
  const ledger = [...rows, ...legacyBackfillRows(payment).map((row, index) => ({ ...row, id: `legacy-backfill-${index}`, createdAt: new Date() }))];
  const { slices } = buildRefundAllocationSlices(ledger, params.refundAmountCents);
  const plannedCardRefundCents = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  return sizeCancelCardShortfall(
    { refundAmountCents: params.refundAmountCents, plannedCardRefundCents },
    () => sumHeadroomCents(nonCardChargeHeadroom(ledger.filter((row) => isCapturedTransactionStatus(row.status)))),
  );
}

/**
 * #4119 (`INV-PAY-129`): the cancel preview's card line, sized as the cancel
 * will size it. Since #4097 a card cancel refunds to the card only what its
 * card refund plan carries and owes the rest by hand, so a preview quoting the
 * policy's whole refund as "to card" promised more than the cancel sends.
 *
 * Asked only where the cancel raises those parts: a card refund on the card
 * branch (`paidCancellationBranch`), not forced to account credit or to the
 * group organiser's card (`forcedCancelRefundMethod`). Advisory, like the rest
 * of the preview: the cancel re-plans under its locks.
 *
 * Returns `{ cardShortfall }` to spread into the preview's answer when the plan
 * is short, or nothing when the card carries the whole refund.
 */
export async function cancelPreviewCardShortfall(
  db: PaymentStore,
  params: {
    payment: { id: string; source: PaymentSource | string | null; manuallyMarkedPaidAt: Date | null };
    /** The joiner's booking the group organiser paid by card (`organiserChildCancelBasis` answered). */
    organiserCard: boolean;
    /** The preview's card-tier refund. */
    refundAmountCents: number;
  },
): Promise<{ cardShortfall?: CancelCardRefundSplit }> {
  const { payment, organiserCard, refundAmountCents } = params;
  if (forcedCancelRefundMethod(payment.source, organiserCard) !== null) return {};
  const manualDisposition = !organiserCard && Boolean(payment.manuallyMarkedPaidAt);
  if (paidCancellationBranch({ manualDisposition, refundMethod: "card", refundAmountCents }) !== "card") return {};
  const cardShortfall = await previewCancelCardRefundSplit(db, { paymentId: payment.id, refundAmountCents });
  return cardShortfall ? { cardShortfall } : {};
}
