/**
 * Read-only report of settled bank-transfer receipts whose recorded figure is
 * not the cash Xero recorded against their invoice (#3979, `INV-PAY-124`).
 *
 * Before #3979 the inbound settle kept the figure an Internet Banking payment
 * and its PRIMARY row were born with, so a booking re-priced (or charged a
 * recorded fee) before its invoice was raised was settled at its old price:
 * the booking ledger's bank receipt, and every refund and credit cap reading
 * the payment, were wrong. #3979 records the cash for new settles; no row
 * already settled is changed (no automatic backfill). This lists them, so the
 * treasurer can correct each by hand with the evidence in front of them.
 *
 * For every payment with a captured Internet Banking PRIMARY row on a Xero
 * invoice, not settled by an officer by hand (`INV-PAY-001`):
 *
 *   recorded = the PRIMARY row's amount
 *   cash     = the payments Xero recorded against that invoice, as the inbound
 *              invoice sync stored them (`INVOICE_PAYMENT` links on the payment,
 *              less any Xero reports DELETED or VOIDED -
 *              `isRecordedBookingInvoicePayment`)
 *
 * and reports every row where they differ. Two shapes are listed APART, never
 * as a difference, because local data cannot say what the cash was: a receipt
 * with no payment link (an invoice paid by an operator-applied overpayment or
 * prepayment, which Xero records as an allocation, or one settled before the
 * links were written), and a link whose amount cannot be read.
 *
 * REPORT ONLY - IT NEVER WRITES AND NEVER REPAIRS. It issues typed SELECTs
 * through Prisma (`INV-OPS-001`) and calls no provider.
 */
import { PaymentSource, PaymentTransactionKind } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { INVOICE_PAYMENT_ROLE, isRecordedBookingInvoicePayment } from "@/lib/xero-inbound/object-links";
import { asRecord, readString } from "@/lib/xero-json";

export type IbSettledCashEvidence =
  /** The invoice's recorded payments were read; `cashCents` is their sum. */
  | "payments"
  /** No payment against the invoice is recorded locally. */
  | "none"
  /** A recorded payment's amount could not be read. */
  | "unreadable";

export interface IbSettledCashRow {
  paymentId: string;
  bookingId: string;
  bookingStatus: string;
  xeroInvoiceId: string;
  xeroInvoiceNumber: string | null;
  /** The captured PRIMARY row's figure - what the ledger's bank receipt posts. */
  recordedCents: number;
  /** `Payment.amountCents`, which refund and credit caps read. */
  paymentAmountCents: number;
  evidence: IbSettledCashEvidence;
  /** The cash Xero recorded; null unless `evidence` is "payments". */
  cashCents: number | null;
}

export interface IbSettledCashAuditResult {
  /** Captured bank-transfer receipts read. */
  scanned: number;
  /** Receipts whose figure differs from the cash on record. */
  differences: IbSettledCashRow[];
  /** Receipts local data cannot judge: no payment link, or one that cannot be read. */
  unjudged: IbSettledCashRow[];
}

type PaymentLink = { localId: string; xeroObjectType: string; role: string | null; metadata: unknown };

/**
 * The cash recorded against one invoice from a payment's links: the sum of its
 * recorded payments, or why it cannot be summed.
 */
export function recordedInvoiceCash(
  links: readonly PaymentLink[],
  invoiceId: string,
): { evidence: IbSettledCashEvidence; cashCents: number | null } {
  const recorded = links.filter(
    (link) =>
      link.role === INVOICE_PAYMENT_ROLE &&
      readString(asRecord(link.metadata)?.invoiceId) === invoiceId &&
      isRecordedBookingInvoicePayment(link),
  );
  if (recorded.length === 0) return { evidence: "none", cashCents: null };
  let cashCents = 0;
  for (const link of recorded) {
    const cents = providerAmountToCents(asRecord(link.metadata)?.amount);
    if (cents === null) return { evidence: "unreadable", cashCents: null };
    cashCents += cents;
  }
  return { evidence: "payments", cashCents };
}

export async function auditIbSettledCash(db: Pick<typeof prisma, "payment" | "xeroObjectLink"> = prisma): Promise<IbSettledCashAuditResult> {
  const payments = await db.payment.findMany({
    where: {
      source: PaymentSource.INTERNET_BANKING,
      manuallyMarkedPaidAt: null,
      transactions: {
        some: {
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.INTERNET_BANKING,
          status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
          xeroInvoiceId: { not: null },
        },
      },
    },
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      booking: { select: { status: true } },
      transactions: {
        where: {
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.INTERNET_BANKING,
          status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
          xeroInvoiceId: { not: null },
        },
        select: { amountCents: true, xeroInvoiceId: true, xeroInvoiceNumber: true },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const links: PaymentLink[] =
    payments.length === 0
      ? []
      : await db.xeroObjectLink.findMany({
          where: {
            localModel: "Payment",
            localId: { in: payments.map((payment) => payment.id) },
            xeroObjectType: "PAYMENT",
            role: INVOICE_PAYMENT_ROLE,
            active: true,
          },
          select: { localId: true, xeroObjectType: true, role: true, metadata: true },
        });

  const result: IbSettledCashAuditResult = { scanned: 0, differences: [], unjudged: [] };
  for (const payment of payments) {
    const paymentLinks = links.filter((link) => link.localId === payment.id);
    for (const receipt of payment.transactions) {
      const invoiceId = receipt.xeroInvoiceId!;
      result.scanned += 1;
      const cash = recordedInvoiceCash(paymentLinks, invoiceId);
      const row: IbSettledCashRow = {
        paymentId: payment.id,
        bookingId: payment.bookingId,
        bookingStatus: payment.booking.status,
        xeroInvoiceId: invoiceId,
        xeroInvoiceNumber: receipt.xeroInvoiceNumber,
        recordedCents: receipt.amountCents,
        paymentAmountCents: payment.amountCents,
        evidence: cash.evidence,
        cashCents: cash.cashCents,
      };
      if (cash.evidence !== "payments") result.unjudged.push(row);
      else if (cash.cashCents !== receipt.amountCents) result.differences.push(row);
    }
  }
  return result;
}

export function formatIbSettledCashReport(result: IbSettledCashAuditResult, format: ClubFormat): string {
  const lines = [
    "Settled bank-transfer receipts against the cash Xero recorded (#3979, INV-PAY-124)",
    `  receipts read: ${result.scanned}`,
    `  recorded figure differs from the cash: ${result.differences.length}`,
    `  cannot be judged from local data: ${result.unjudged.length}`,
  ];
  if (result.differences.length > 0) {
    lines.push("", "Differences (recorded vs cash; correct each by hand in the app and Xero):");
    for (const row of result.differences) {
      lines.push(
        `  booking ${row.bookingId} (${row.bookingStatus}) payment ${row.paymentId} invoice ${row.xeroInvoiceNumber ?? row.xeroInvoiceId}: recorded ${formatCents(row.recordedCents, format)}, cash ${formatCents(row.cashCents ?? 0, format)}, payment figure ${formatCents(row.paymentAmountCents, format)}`,
      );
    }
  }
  if (result.unjudged.length > 0) {
    lines.push("", "Not judged (check the invoice in Xero):");
    for (const row of result.unjudged) {
      const why =
        row.evidence === "none"
          ? "no payment recorded locally - paid by an applied overpayment or prepayment, or settled before payments were linked"
          : "a recorded payment's amount cannot be read";
      lines.push(
        `  booking ${row.bookingId} (${row.bookingStatus}) payment ${row.paymentId} invoice ${row.xeroInvoiceNumber ?? row.xeroInvoiceId}: recorded ${formatCents(row.recordedCents, format)}; ${why}`,
      );
    }
  }
  return lines.join("\n");
}
