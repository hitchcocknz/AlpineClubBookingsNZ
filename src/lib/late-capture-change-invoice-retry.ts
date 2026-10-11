import type { ClubFormat } from "@/lib/club-format";
import { findLateCaptureRefundPaidAnotherWay } from "@/lib/late-capture-paid-another-way";
import { findActiveSupplementaryInvoiceLink } from "@/lib/late-capture-xero-receipt";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #3924 round 10 (`INV-PAY-122`): THE TWO QUESTIONS an officer's retry of a
 * FAILED change invoice released for a late capture asks before it sends the
 * row back through the outbox (`retryXeroSyncOperation`).
 */

/**
 * Is the payload's intent a late capture an approval task owns
 * (`lateCaptureApprovalIntentId`) - the late charge whose refund a close can
 * wait on? An ordinary card edit's invoice names its `paymentIntentId` too, and
 * keeps the inline replay.
 */
export async function isLateCaptureApprovalChangeInvoice(payload: Record<string, unknown>): Promise<boolean> {
  const intent = payload.paymentIntentId;
  if (typeof intent !== "string" || intent === "") return false;
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: intent },
    select: { id: true },
  });
  return task !== null;
}

/**
 * Is that change invoice ALREADY IN XERO - its change carries the active
 * `SUPPLEMENTARY_INVOICE` link `createXeroSupplementaryInvoice` writes once
 * Xero returns the invoice, though the row failed after it? Then it is never
 * sent again, since a retry could raise a second invoice for one charge: the
 * refusal (a 409) tells the officer to mark the row resolved as fixed in Xero.
 * The link is the receipt reader's (`findActiveSupplementaryInvoiceLink`).
 * Null when it may be sent.
 *
 * Round 12 (`INV-PAY-122`): WHAT TO RECORD BY HAND, AND WHAT NOT. Once the row
 * is resolved the two receipt verdicts part. A refund closed as paid another
 * way reads the linked invoice as its receipt
 * (`readPaidAnotherWayLateCaptureXeroReceipt`), so the app raises the close's
 * note - through the nightly credit check or the repair tool, since marking
 * the row resolved runs no note step - and that share is never recorded by
 * hand. Every card-refund path reads the row resolved by hand
 * (`readLateCaptureXeroReceipt`), so the app raises no note for the capture's
 * card refunds, and the refusal names what of them no note answers
 * (`readUnnotedLateCaptureCardRefundCents`) to record by hand.
 */
export async function linkedChangeInvoiceRetryRefusal(
  operation: { localModel: string | null; localId: string | null },
  payload: Record<string, unknown>,
  format: ClubFormat,
): Promise<string | null> {
  const linked = await findActiveSupplementaryInvoiceLink([operation]);
  if (!linked) return null;
  const paymentIntentId = String(payload.paymentIntentId);
  const close = await findLateCaptureRefundPaidAnotherWay(paymentIntentId);
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { paymentId: true },
  });
  const paymentId = close?.paymentId ?? task?.paymentId ?? null;
  // Imported here, not at the top: that module reaches the outbox.
  const { readUnnotedLateCaptureCardRefundCents } = await import("@/lib/late-capture-refund-credit-note");
  return linkedChangeInvoiceRetryRefusalMessage(
    {
      closeCents: close ? Math.max(0, close.amountCents ?? 0) : null,
      cardByHandCents: paymentId ? await readUnnotedLateCaptureCardRefundCents(paymentId, paymentIntentId) : 0,
    },
    format,
  );
}

/** The 409's words: the close's share is never recorded by hand, the card refunds always are. */
function linkedChangeInvoiceRetryRefusalMessage(
  { closeCents, cardByHandCents }: { closeCents: number | null; cardByHandCents: number },
  format: ClubFormat,
): string {
  const parts = [
    "This late card charge's change invoice is already in Xero, so retrying it could raise a second invoice. Mark this operation resolved as fixed in Xero instead.",
  ];
  if (closeCents !== null && closeCents > 0) {
    parts.push(
      `Do not record the ${formatCents(closeCents, format)} paid back another way by hand: the app raises that refund note against the invoice already there, through the nightly credit check or the Xero repair tool.`,
    );
  }
  if (cardByHandCents > 0) {
    parts.push(
      `Record the ${formatCents(cardByHandCents, format)} refunded to the card by hand in Xero: once this operation is resolved the app raises no refund note for a card refund of this charge.`,
    );
  } else if (closeCents === null) {
    parts.push(
      "If this charge is refunded to the card, record that refund by hand in Xero: once this operation is resolved the app raises no refund note for it.",
    );
  }
  return parts.join(" ");
}
