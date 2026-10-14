import { PaymentStatus, type Prisma } from "@prisma/client";

/**
 * #4119: the order the fold walks a payment's captured rows, and the order the
 * capture ledger loads in (`loadPaymentWithTransactions`), so the cancel's
 * claim and the cancel preview fold onto the same rows. Deliberately no `id`
 * tiebreak: rows written in one transaction can share a `createdAt`, and the
 * ledger's readers rely on them coming back in insertion order, which a cuid
 * `id` does not follow (an `id` tiebreak broke the #3954 real-PostgreSQL race
 * proof). A deterministic tiebreak needs a monotonic column (#4132).
 */
export const CAPTURED_ROWS_OLDEST_FIRST = {
  createdAt: "asc",
} as const satisfies Prisma.PaymentTransactionOrderByWithRelationInput;

/**
 * #1491 (review): the part of a PARTIALLY_REFUNDED payment mirror's refunded
 * total its capture ledger does not show - an invoice-applied credit note the
 * inbound reconcile folded into `Payment.refundedAmountCents` without touching
 * a transaction row - attributed to the captured rows OLDEST FIRST, each up to
 * what it will take.
 *
 * ONE walk for the paid cancel's claim, which writes each step
 * (`foldIntoTransactionRefundedAmount`, capped at the row's headroom), and the
 * cancel preview (#4119, `INV-PAY-131`), which applies the same steps to its
 * read in memory (`refundHeadroomIncrementCents`), so both plan the card refund
 * from the same ledger. `readCapturedRowsOldestFirst` is asked only for a
 * partly refunded payment; `apply` returns what the row actually took, and the
 * rest moves on to the next row.
 */
export async function foldMirrorRefundIntoLedger<R extends { refundedAmountCents: number }>(
  payment: { status: PaymentStatus | string; refundedAmountCents: number },
  readCapturedRowsOldestFirst: () => Promise<readonly R[]> | readonly R[],
  apply: (row: R, cents: number) => Promise<number> | number,
): Promise<void> {
  if (payment.status !== PaymentStatus.PARTIALLY_REFUNDED) return;
  const rows = await readCapturedRowsOldestFirst();
  let foldedCents = payment.refundedAmountCents - rows.reduce((sum, row) => sum + row.refundedAmountCents, 0);
  for (const row of rows) {
    if (foldedCents <= 0) break;
    foldedCents -= await apply(row, foldedCents);
  }
}
