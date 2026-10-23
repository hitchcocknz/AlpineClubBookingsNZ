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

/** The link the capture's Xero payment writes, on its `PaymentTransaction`. */
export const ADDITIONAL_CAPTURE_PAYMENT_ROLE = "ADDITIONAL_CAPTURE_PAYMENT";

/**
 * #3953: the Xero invoice a capture's receipt was recorded against, from its
 * payment link, or null. The refund paths read it, so a refund of that capture
 * names the invoice the capture paid.
 */
export async function findAdditionalCaptureReceiptInvoiceId(
  paymentIntentId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction" | "xeroObjectLink"> = prisma,
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
  const invoiceId = asRecord(link?.metadata)?.invoiceId;
  return typeof invoiceId === "string" && invoiceId.length > 0 ? invoiceId : null;
}
