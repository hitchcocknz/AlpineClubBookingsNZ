/**
 * #3954 DECISION A (owner, 9 Oct 2026, "Raise a $30 invoice"): A PRICE
 * REDUCTION'S SMALLER RE-ISSUED ASK GETS ITS OWN SUPPLEMENTARY XERO INVOICE.
 *
 * The reduction retired the increase's parked invoice with the ask it waited
 * on (`retireUnpaidAskChain`) and recorded, on its own history row, what the
 * smaller ask's invoice bills (`recordedReissuedAskInvoiceCents`: the retired
 * invoices' money less the offset, never more than the ask). Once that ask is
 * minted - by the door after commit or by its recovery's replay - its invoice
 * is queued on the reducing edit, parked `WAITING_PAYMENT` on the minted
 * intent and recording the payment when it is captured, exactly as an
 * ordinary increase's invoice waits for its intent. Xero then matches what
 * the member is asked to pay.
 *
 * Best-effort, like every after-commit Xero leg: a failure is logged, and the
 * booking-vs-Xero repair pass reports the reduction's missing invoice. The
 * enqueue's one-invoice-per-anchor lock makes a second call (door and replay
 * both reaching here) queue nothing.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  recordedFoldedReissuedAskModificationIds,
  recordedReissuedAskInvoiceCents,
} from "@/lib/unpaid-ask-offset-marker";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";

export async function queueReissuedAskSupplementaryInvoice({
  bookingId,
  bookingModificationId,
  paymentIntentId,
}: {
  bookingId: string;
  /** The REDUCING edit, whose history records the figure and which anchors the invoice. */
  bookingModificationId: string;
  /** The re-issued ask's minted intent, which releases the invoice when captured. */
  paymentIntentId: string;
}): Promise<void> {
  try {
    const modification = await prisma.bookingModification.findUnique({
      where: { id: bookingModificationId },
      select: { newData: true },
    });
    const invoiceCents = recordedReissuedAskInvoiceCents(modification?.newData);
    if (invoiceCents <= 0) return;
    await enqueueXeroSupplementaryInvoiceOperation(
      { bookingId, priceDiffCents: invoiceCents, changeFeeCents: 0, bookingModificationId },
      { paymentIntentId, waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  } catch (err) {
    logger.error(
      { err, bookingId, bookingModificationId, paymentIntentId },
      "Failed to queue the supplementary Xero invoice for a re-issued additional ask (#3954); the booking-vs-Xero repair pass reports it",
    );
  }
}

/**
 * #3954 review round 6: THE RE-ISSUES AN INCREASE FOLDED IN KEEP THEIR OWN
 * INVOICES. A later increase that folded a waiting re-issue into its own ask
 * (`foldWaitingReissuedAsks`) closed that re-issue's recovery, so the
 * re-issue's own mint - which queues its decision-A invoice - never runs. Once
 * the increase's ask is minted, by its door or its recovery's replay, each
 * folded reduction's invoice is queued here instead, anchored on that
 * reduction as before and waiting on the INCREASE's intent, which now asks for
 * that money. The per-anchor lock keeps a second call (door and replay) to one.
 */
export async function queueFoldedReissuedAskInvoices({
  bookingId,
  increaseModificationId,
  paymentIntentId,
}: {
  bookingId: string;
  /** The increase whose history records what it folded in. */
  increaseModificationId: string;
  /** Its minted intent, which collects the folded re-issues' money. */
  paymentIntentId: string;
}): Promise<void> {
  let folded: string[];
  try {
    const increase = await prisma.bookingModification.findUnique({
      where: { id: increaseModificationId },
      select: { newData: true },
    });
    folded = recordedFoldedReissuedAskModificationIds(increase?.newData);
  } catch (err) {
    logger.error(
      { err, bookingId, increaseModificationId, paymentIntentId },
      "Failed to read the re-issues an increase folded in (#3954); the booking-vs-Xero repair pass reports their invoices",
    );
    return;
  }
  for (const bookingModificationId of folded) {
    await queueReissuedAskSupplementaryInvoice({ bookingId, bookingModificationId, paymentIntentId });
  }
}
