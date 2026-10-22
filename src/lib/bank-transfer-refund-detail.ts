import type { Prisma } from "@prisma/client";

import { findPostedSettlementLines } from "@/lib/booking-ledger-read";
import { ledgerLineAmountCents } from "@/lib/booking-ledger-write";

type Reader = Pick<Prisma.TransactionClient, "payment" | "paymentTransaction" | "bookingLedgerLine">;

/**
 * #4290 (`INV-ADDPAY-043`): THE REFUNDS THE CLUB RECORDED ON A BANK-TRANSFER
 * PAYMENT - the detail the #4162 floor never lets the inbound Xero recount take
 * its refunded total below (`INV-ADDPAY-021`,
 * `floorBankTransferRefundedTotal`). Two records, and no refund is in both:
 *
 * - **Its charge rows' refunded detail** (`PaymentTransaction`): every
 *   hand-back a person completed lands there (`applyLocalRefundAllocation`).
 * - **A group joiner's refund out of its organiser's Internet Banking
 *   settlement**: the live `GROUP_SETTLEMENT` `BANK_REFUND` line the
 *   organiser's cancel posts on the joiner's booking in the same transaction
 *   as the joiner's mirror (`postGroupCancelChildLedgerLines`, #3854, #4042).
 *   A joiner's payment has no charge row: the group settle writes none,
 *   because the settlement posts the joiner's share itself and a charge row
 *   would post a second receipt (`syncBookingLedgerSettlements`). So before
 *   #4290 a joiner's detail read 0, and a voided or short note took its total
 *   down with no alert. Its own refund line is the joiner's record, as it is
 *   the organiser's hand-back's proof (`group-organiser-hand-back.ts`),
 *   net of any reversal.
 *
 * This is the floor's figure only. The nightly void follow-up's detail stays
 * the charge rows' (`bank-refund-void-scan.ts`): what an undo can unwind. A
 * joiner's void has no hand-back line of its own to undo, so the follow-up
 * lists it for a person (`no-line`), and the floor keeps the total meanwhile.
 * Read-only; the caller decides what to lock.
 */
export async function bankTransferRefundDetailCents(db: Reader, paymentId: string): Promise<number> {
  const detail = await db.paymentTransaction.aggregate({ where: { paymentId }, _sum: { refundedAmountCents: true } });
  const chargeRowsCents = Math.max(0, detail._sum.refundedAmountCents ?? 0);
  const payment = await db.payment.findUnique({ where: { id: paymentId }, select: { bookingId: true } });
  if (!payment) return chargeRowsCents;
  const joinerLines = await findPostedSettlementLines(db, payment.bookingId, { kind: "BANK_REFUND", anchorKind: "GROUP_SETTLEMENT" });
  // A refund line is a credit to the member (negative); its reversal, same kind and anchor, nets it out.
  const joinerRefundCents = joinerLines.reduce((sum, line) => sum - ledgerLineAmountCents(line), 0);
  return chargeRowsCents + Math.max(0, joinerRefundCents);
}
