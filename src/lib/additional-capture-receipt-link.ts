/**
 * #3953 (`INV-PAY-138`): where a booking change's card capture was recorded in
 * Xero by its own receipt (`additional-capture-xero-receipt.ts`) - the link
 * its Xero payment writes on the capture's `PaymentTransaction`, naming the
 * invoice it paid. A leaf, so the refund paths read it without the worker's
 * import graph (`INV-SSOT`: the one spelling of the role and the read).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";

/** The link the capture's Xero payment writes, on its `PaymentTransaction`. */
export const ADDITIONAL_CAPTURE_PAYMENT_ROLE = "ADDITIONAL_CAPTURE_PAYMENT";

/**
 * #3953: the Xero invoice a capture's receipt was recorded against, from its
 * payment link, or - review round 1 (L) - the invoice its receipt row has
 * already decided on and is sending to (the plan stored before the Xero call).
 * Null otherwise. The refund paths read it, so a refund of that capture names
 * the invoice the capture paid.
 */
export async function findAdditionalCaptureReceiptInvoiceId(
  paymentIntentId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation"> = prisma,
): Promise<string | null> {
  const transaction = await store.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true },
  });
  if (!transaction) return null;
  const link = await store.xeroObjectLink.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: transaction.id,
      xeroObjectType: "PAYMENT",
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      active: true,
    },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const linked = asRecord(link?.metadata)?.invoiceId;
  if (typeof linked === "string" && linked.length > 0) return linked;
  const pending = await store.xeroSyncOperation.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: transaction.id,
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { notIn: ["CANCELLED", "SUCCEEDED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  const planned = asRecord(asRecord(pending?.requestPayload)?.plan)?.invoiceId;
  return typeof planned === "string" && planned.length > 0 ? planned : null;
}

/**
 * #3953 review round 6 (item 1a): WHETHER A CAPTURE THIS SUPPLEMENTARY INVOICE
 * WOULD RECORD ALREADY HAS A RECEIPT RECORDING IT - its payment linked, its row
 * RUNNING, or a decision stored on it. The supplementary enqueue asks this
 * under the anchor's lock, and raises the invoice unpaid where it is so, so
 * one capture never has two recorders whatever a repair sweep's snapshot said.
 * The captures are those of the change (`bookingModificationId`) and the one
 * the invoice names (`paymentIntentId`).
 */
export async function anchorCaptureHasReceipt(
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation">,
  input: { bookingModificationId: string | null; paymentIntentId: string | null },
): Promise<boolean> {
  const arms = [
    ...(input.bookingModificationId ? [{ bookingModificationId: input.bookingModificationId }] : []),
    ...(input.paymentIntentId ? [{ stripePaymentIntentId: input.paymentIntentId }] : []),
  ];
  if (arms.length === 0) return false;
  const captures = await store.paymentTransaction.findMany({
    where: { kind: "ADDITIONAL", OR: arms },
    select: { id: true },
  });
  const ids = captures.map((capture) => capture.id);
  if (ids.length === 0) return false;
  const [linked, receipts] = await Promise.all([
    store.xeroObjectLink.findFirst({
      where: { localModel: "PaymentTransaction", localId: { in: ids }, role: ADDITIONAL_CAPTURE_PAYMENT_ROLE, active: true },
      select: { id: true },
    }),
    store.xeroSyncOperation.findMany({
      where: {
        localModel: "PaymentTransaction",
        localId: { in: ids },
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        status: { not: "CANCELLED" },
      },
      select: { status: true, requestPayload: true },
    }),
  ]);
  return (
    linked !== null ||
    receipts.some((receipt) => receipt.status === "RUNNING" || asRecord(receipt.requestPayload)?.plan != null)
  );
}
