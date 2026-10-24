import "server-only";

import { PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import logger from "@/lib/logger";
import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import { CREDIT_RELEASE_ASK_REASON } from "@/lib/payment-recovery-keys";
import { lockPaymentForRefundedTotal, recordInternetBankingPaymentTransaction } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { cancelPaymentIntentIfCancellableWithResult } from "@/lib/stripe";
import { isSettledInXero, readXeroInvoiceBalance, type XeroInvoiceBalanceReader } from "@/lib/xero-invoice-balance";

/**
 * CLOSE A CREDIT-RELEASE REQUEST WHEN XERO SHOWS THE INVOICE PAID (#4253,
 * `INV-ADDPAY-044`, owner decision D6: the member may pay by card OR bank transfer).
 *
 * The released amount stands on the booking's own invoice, so a member who pays
 * that invoice by bank transfer, or a treasurer who settles it in Xero, has paid
 * what the card request asks for. Left open, the request would go on chasing the
 * member and a later card payment would pay the same money twice. So when Xero
 * shows the invoice PAID while the request is unpaid here, the request is closed
 * and the money is written into the ledger as what it was: internet-banking cash on
 * the booking's additional payments, so the booking still balances (`INV-PAY-047`).
 *
 * This is the SEAM #4270's inbound mirror will feed: it reads Xero on a schedule
 * today, and takes a pre-read balance when the inbound sync knows the invoice
 * changed. The decision and the write stay here.
 *
 * ORDER, as the officer's withdrawal does it: the provider cancel first and outside
 * any lock; then one transaction under the global key that re-asserts the row
 * before writing. An intent Stripe reports as succeeded or still processing is
 * LEFT ALONE - the card payment won, and the payment recorder will hold and alert
 * (the invoice is no longer open) rather than record it twice.
 *
 * ONLY A REQUEST THAT CARRIES NOTHING. One that absorbed another ask's balance
 * (`carriedAskCents` > 0) is part something else's money, which a paid invoice says
 * nothing about, so it stays open for a person.
 */
export const CREDIT_RELEASE_PAID_IN_XERO_REASON = "credit_released_paid_in_xero";

export type CreditReleaseCloseResult = { closed: number; left: number };

export type CreditReleaseCloseDeps = {
  readInvoiceBalance: XeroInvoiceBalanceReader;
  cancelIntent: typeof cancelPaymentIntentIfCancellableWithResult;
};

export async function closeCreditReleaseAsksPaidInXero(
  options: { limit?: number; deps?: Partial<CreditReleaseCloseDeps>; now?: Date } = {},
): Promise<CreditReleaseCloseResult> {
  const deps: CreditReleaseCloseDeps = {
    readInvoiceBalance: readXeroInvoiceBalance,
    cancelIntent: cancelPaymentIntentIfCancellableWithResult,
    ...options.deps,
  };
  const result: CreditReleaseCloseResult = { closed: 0, left: 0 };
  const open = await prisma.paymentTransaction.findMany({
    where: {
      kind: PaymentTransactionKind.ADDITIONAL,
      source: PaymentSource.STRIPE,
      reason: CREDIT_RELEASE_ASK_REASON,
      withdrawnAt: null,
      carriedAskCents: 0,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED] },
    },
    orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
    take: options.limit ?? 25,
    select: { id: true, paymentId: true, amountCents: true, stripePaymentIntentId: true },
  });

  for (const ask of open) {
    const payment = await prisma.payment.findUnique({
      where: { id: ask.paymentId },
      select: {
        xeroInvoiceId: true,
        additionalPaymentIntentId: true,
        booking: { select: { id: true, memberId: true, member: true, organisation: { select: { name: true, email: true } } } },
      },
    });
    // Only the LIVE request (the one the payment's summary points at) is closed.
    if (!payment?.xeroInvoiceId || payment.additionalPaymentIntentId !== ask.stripePaymentIntentId) {
      result.left += 1;
      continue;
    }
    let settled: Awaited<ReturnType<XeroInvoiceBalanceReader>>;
    try {
      settled = await deps.readInvoiceBalance(payment.xeroInvoiceId);
    } catch (err) {
      logger.warn({ err, askRowId: ask.id }, "Could not read the booking's Xero invoice to close a credit-release request; leaving it open");
      result.left += 1;
      continue;
    }
    if (!isSettledInXero(settled)) {
      result.left += 1;
      continue;
    }

    if (ask.stripePaymentIntentId) {
      try {
        const cancelled = await deps.cancelIntent(ask.stripePaymentIntentId, { cancellationReason: "duplicate" });
        const status = cancelled.paymentIntent.status;
        if (status === "succeeded" || (!cancelled.canceled && status !== "canceled")) {
          result.left += 1;
          continue;
        }
      } catch (err) {
        logger.error({ err, askRowId: ask.id }, "Could not cancel a credit-release request's card payment; leaving it open");
        result.left += 1;
        continue;
      }
    }

    const closed = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await lockPaymentForRefundedTotal(tx, ask.paymentId);
        // The fence: the row is still this unpaid, unwithdrawn request and still the live one.
        const stamped = await tx.paymentTransaction.updateMany({
          where: {
            id: ask.id,
            withdrawnAt: null,
            carriedAskCents: 0,
            status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.FAILED] },
          },
          data: { status: PaymentStatus.FAILED, withdrawnAt: options.now ?? new Date() },
        });
        if (stamped.count !== 1) return false;
        await recordInternetBankingPaymentTransaction({
          paymentId: ask.paymentId,
          kind: PaymentTransactionKind.ADDITIONAL,
          amountCents: ask.amountCents,
          status: PaymentStatus.SUCCEEDED,
          xeroInvoiceId: settled.invoiceId,
          xeroInvoiceNumber: settled.invoiceNumber,
          reference: settled.invoiceNumber ? `Xero ${settled.invoiceNumber}` : null,
          reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
          store: tx,
        });
        await createAuditLog(
          {
            action: "payment.credit_release_ask.closed_paid_in_xero",
            subjectMemberId: bookingOwner(payment.booking).memberId,
            targetId: payment.booking.id,
            entityType: "Booking",
            entityId: payment.booking.id,
            category: "payment",
            severity: "important",
            outcome: "success",
            summary: "A card payment request for credit used in Xero was closed because Xero shows the invoice paid",
            metadata: { askRowId: ask.id, amountCents: ask.amountCents, paymentIntentId: ask.stripePaymentIntentId },
          },
          tx,
        );
        return true;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    if (closed) result.closed += 1;
    else result.left += 1;
  }
  return result;
}
