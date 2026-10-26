/**
 * #3403 review (M1; `INV-PAY-070`): A CAPTURE OF A SUPERSEDED ASK TAKES ITS
 * INVOICE BACK.
 *
 * A superseded card change's waiting invoice moves onto the request carrying
 * its balance (`followSupersededAskInvoicesToCarrier`). A DECLINED ask is never
 * cancelled at Stripe, so a stale tab can still pay it, and the club keeps that
 * capture like any other. Its change's invoice must then record THAT capture:
 * left on the carrier, the capture's release would find nothing parked on it,
 * its receipt would stand down to the change's own invoice
 * (`readCaptureRecorder`), and if the carrier were never paid the invoice
 * would be retired - the capture recorded nowhere.
 *
 * So the late-capture release, for a capture the club KEEPS, first returns
 * every invoice still `WAITING_PAYMENT` that was first parked on this intent
 * (`SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY`) to wait on it again, then releases
 * as it always has. Per change, under that change's supplementary-invoice key
 * (`lockSupplementaryInvoiceAnchor`) - the key this capture's receipt decides
 * under too, since a member ask is stamped with its change - with a write
 * guarded on the status, the intent it was moved to and the correlation key.
 * An invoice the carrier's capture already released has recorded that
 * capture, and stays as it is.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY } from "@/lib/supplementary-invoice-parked-from";
import { asRecord } from "@/lib/xero-json";
import { lockSupplementaryInvoiceAnchor } from "@/lib/xero-operation-outbox";
import { SUPPLEMENTARY_INVOICE_CREATE_WHERE } from "@/lib/xero-supplementary-invoice-statuses";

function movedOffIntentWhere(paymentIntentId: string): Prisma.XeroSyncOperationWhereInput {
  return {
    ...SUPPLEMENTARY_INVOICE_CREATE_WHERE,
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    requestPayload: { path: [SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY], equals: paymentIntentId },
  };
}

/** Return this captured intent's moved, still-waiting invoices to it. Answers how many moved back. */
export async function returnMovedInvoicesToCapturedIntent(paymentIntentId: string): Promise<number> {
  const moved = await prisma.xeroSyncOperation.findMany({
    where: movedOffIntentWhere(paymentIntentId),
    select: { localId: true },
  });
  const anchors = [...new Set(moved.flatMap((row) => (row.localId ? [row.localId] : [])))].sort();
  let returned = 0;
  for (const anchorId of anchors) {
    returned += await prisma.$transaction(async (tx) => {
      await lockSupplementaryInvoiceAnchor(tx, anchorId);
      const rows = await tx.xeroSyncOperation.findMany({
        where: { ...movedOffIntentWhere(paymentIntentId), localId: anchorId },
        select: { id: true, requestPayload: true, correlationKey: true },
      });
      let count = 0;
      for (const row of rows) {
        const payload = asRecord(row.requestPayload) ?? {};
        if (typeof payload.paymentIntentId !== "string" || payload.paymentIntentId === paymentIntentId) continue;
        const unmoved = { ...payload };
        delete unmoved[SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY];
        const written = await tx.xeroSyncOperation.updateMany({
          where: {
            id: row.id,
            status: "WAITING_PAYMENT",
            correlationKey: row.correlationKey,
            requestPayload: { path: ["paymentIntentId"], equals: payload.paymentIntentId },
          },
          data: { requestPayload: { ...unmoved, paymentIntentId } as Prisma.InputJsonObject },
        });
        count += written.count;
      }
      return count;
    });
  }
  return returned;
}
