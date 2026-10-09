import { prisma } from "@/lib/prisma";

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
 * The capture's receipt is that linked invoice (`readLateCaptureXeroReceipt`),
 * and the close's refund note is raised against it. Null when it may be sent.
 */
export async function linkedChangeInvoiceRetryRefusal(operation: {
  localModel: string | null;
  localId: string | null;
}): Promise<string | null> {
  if (!operation.localModel || !operation.localId) return null;
  const link = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: operation.localModel,
      localId: operation.localId,
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });
  return link
    ? "This late card charge's change invoice is already in Xero, so retrying it could raise a second invoice. Mark this operation resolved as fixed in Xero instead; the refund note follows against the invoice already there."
    : null;
}
