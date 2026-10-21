/**
 * #3980 review round 2 (F1/F2/F3/F4/F5): a primary invoice's gap invoice that
 * waits on its anchor edit's card ask, kept true to that ask.
 *
 * The gap check queues the gap invoice WAITING_PAYMENT on the anchor's ask -
 * its intent, or none yet where the door has not minted it - with
 * `recordPayment`, as the edit's own supplementary invoice would have been
 * (`classifyAnchorAsk` decides whether the ask is live and its own money covers
 * the gap). {@link settleParkedGapInvoice} then settles it against the ask AS IT
 * NOW STANDS, under the lock a reduction's retire of that ask takes first: the
 * Payment row (`lockPaymentForRefundedTotal`, `retireUnpaidAskChain`). So the
 * retire and this either see each other or wait for each other:
 *
 *  - the retire first: the ask reads withdrawn here, and the invoice - which
 *    the retire could not see, as it did not exist yet - is raised unpaid
 *    instead of waiting on a dead intent for ever;
 *  - this first: the invoice is parked on the intent when the retire reads its
 *    parked invoices, and the retire retires it with the ask (`INV-PAY-120`).
 *
 * The same reading attaches a newly minted intent to an invoice waiting on
 * none, raises an ask that is declined, withdrawn or too small unpaid, and,
 * for an ask already captured, hands the invoice to the one path that releases
 * a waiting invoice for a captured intent
 * (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`), so the capture's
 * coverage and refund rules apply here too (`INV-SSOT`).
 *
 * Run by the gap check after it queues the invoice, and by the door's Xero leg
 * once it has minted the ask (`queueXeroBookingEditSettlement`); whichever runs
 * second finds the other's write. Only an invoice waiting on no intent, or on
 * this ask's intent, is touched: any other waiting invoice on the edit is not
 * the gap's.
 */
import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { classifyAnchorAsk, readAnchorAsk } from "@/lib/xero-primary-invoice-gap-anchors";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { recordedPrimaryInvoiceSettlement } from "@/lib/booking-primary-invoice-claim";

export type ParkedGapInvoiceSettlement = {
  attached: string[];
  raisedUnpaid: string[];
  capturedIntentId: string | null;
};

export async function settleParkedGapInvoice(input: {
  bookingId: string;
  bookingModificationId: string;
}): Promise<ParkedGapInvoiceSettlement> {
  const settled = await prisma.$transaction(async (tx) => {
    const result: ParkedGapInvoiceSettlement = { attached: [], raisedUnpaid: [], capturedIntentId: null };
    const payment = await tx.payment.findUnique({ where: { bookingId: input.bookingId }, select: { id: true } });
    if (!payment) return result;
    // The lock the reduction's retire takes first (`INV-LOCK-002`).
    await lockPaymentForRefundedTotal(tx, payment.id);
    const anchor = await tx.bookingModification.findUnique({
      where: { id: input.bookingModificationId },
      select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
    });
    if (!anchor || !recordedPrimaryInvoiceSettlement(anchor.newData)) return result;
    const waiting = await tx.xeroSyncOperation.findMany({
      where: {
        status: "WAITING_PAYMENT",
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        localModel: "BookingModification",
        localId: anchor.id,
      },
      select: { id: true, requestPayload: true },
    });
    if (waiting.length === 0) return result;
    const row = await readAnchorAsk(tx, input.bookingId, anchor.id);
    for (const operation of waiting) {
      const payload = asRecord(operation.requestPayload) ?? {};
      const parkedOn = typeof payload.paymentIntentId === "string" ? payload.paymentIntentId : null;
      if (parkedOn && parkedOn !== row?.stripePaymentIntentId) continue;
      const gapCents = numberOf(payload.priceDiffCents) + numberOf(payload.changeFeeCents);
      const ask = classifyAnchorAsk({ anchor, row, gapCents });
      if (ask.kind === "unminted") continue;
      if (ask.kind === "pending" || ask.kind === "captured") {
        if (!parkedOn) {
          await rewriteWaiting(tx, operation.id, { ...payload, paymentIntentId: ask.paymentIntentId });
          result.attached.push(operation.id);
        }
        if (ask.kind === "captured") result.capturedIntentId = ask.paymentIntentId;
        continue;
      }
      // Declined, withdrawn, retired, or too small: nothing will pay it by card.
      const raised = await tx.xeroSyncOperation.updateMany({
        where: { id: operation.id, status: "WAITING_PAYMENT" },
        data: {
          status: "PENDING",
          requestPayload: {
            ...payload,
            recordPayment: false,
            paymentIntentId: null,
            waitForConfirmedAdditionalPayment: false,
          } as Prisma.InputJsonValue,
        },
      });
      if (raised.count === 1) result.raisedUnpaid.push(operation.id);
    }
    return result;
  });
  if (settled.raisedUnpaid.length > 0) {
    logger.warn(
      { ...input, operationIds: settled.raisedUnpaid },
      "A primary invoice's gap invoice was waiting on a card request that will not pay it; it is raised unpaid (#3980)",
    );
  }
  if (settled.capturedIntentId) {
    await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(settled.capturedIntentId);
  }
  return settled;
}

async function rewriteWaiting(
  tx: Prisma.TransactionClient,
  operationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.xeroSyncOperation.updateMany({
    where: { id: operationId, status: "WAITING_PAYMENT" },
    data: { requestPayload: payload as Prisma.InputJsonValue },
  });
}

function numberOf(value: unknown): number {
  return Number.isInteger(value) ? (value as number) : 0;
}
