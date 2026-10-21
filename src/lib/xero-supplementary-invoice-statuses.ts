import type { Prisma } from "@prisma/client";

import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import type { XeroSupplementaryInvoiceAnchorModel } from "@/lib/xero-supplementary-invoice-key";

/**
 * The states in which a supplementary invoice for this anchor is still going to
 * be sent, so a second one must not be queued behind it. Wider than the
 * restatable set by `RUNNING`: an operation the outbox is executing right now
 * cannot have its amount changed, but it is very much still an invoice.
 *
 * Its own leaf (#3502) so the primary booking invoice can read it without
 * importing `xero-operation-outbox.ts`, which imports the primary invoice;
 * that module re-exports it, so no importer moved.
 */
export const OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const;

/**
 * The supplementary-invoice outbox operations of ONE anchor, any status: the
 * shape the enqueue's "is an invoice already going out?" read narrows by status
 * (`outstandingSupplementaryInvoiceOperationsWhere`). Matched on the immutable
 * `queueType` column, as the enqueue always has. #3947 review round 2 named it
 * so the review charge's route chooser asks the same question of the same rows.
 */
export function supplementaryInvoiceAnchorOperationsWhere({
  localModel,
  localId,
}: {
  localModel: XeroSupplementaryInvoiceAnchorModel;
  localId: string;
}): Prisma.XeroSyncOperationWhereInput {
  return {
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel,
    localId,
    queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  };
}

/**
 * THE ENQUEUE'S QUESTION (`enqueueXeroSupplementaryInvoiceOperation`): an
 * invoice for this anchor that is still going to be sent - queued, waiting on a
 * payment, or being sent right now. Finding one, the enqueue raises it rather
 * than queueing a second.
 */
export function outstandingSupplementaryInvoiceOperationsWhere(anchor: {
  localModel: XeroSupplementaryInvoiceAnchorModel;
  localId: string;
}): Prisma.XeroSyncOperationWhereInput {
  return {
    ...supplementaryInvoiceAnchorOperationsWhere(anchor),
    status: { in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES] },
  };
}

/**
 * #3947 review round 2: an invoice for this anchor that is OUTSTANDING (the
 * enqueue's question, above) OR that FAILED and an officer has not marked
 * resolved in Xero - a row the operations panel can still Requeue
 * (`isResolvedInXero`, `INV-INT-025`; the query side spells that
 * `manuallyResolvedAt: null`). Either way the anchor's invoice is still on its
 * way, which is what `chooseEditReviewChargeRoute` needs to know before it
 * offers a later share of the same edit the card. NOT closed here: neither the
 * restate nor the enqueue reads FAILED, so a later share's invoice is a NEW
 * row, and requeuing the failed one beside it bills the edit twice (#4274).
 *
 * `PARTIAL` is deliberately absent: the handler finishes `PARTIAL` only after
 * creating the invoice, and writes its `SUPPLEMENTARY_INVOICE` link in that same
 * completion, so the chooser's issued-link refusal has already answered.
 */
export function supplementaryInvoiceStillComingWhere(anchor: {
  localModel: XeroSupplementaryInvoiceAnchorModel;
  localId: string;
}): Prisma.XeroSyncOperationWhereInput {
  return {
    OR: [
      outstandingSupplementaryInvoiceOperationsWhere(anchor),
      {
        ...supplementaryInvoiceAnchorOperationsWhere(anchor),
        status: "FAILED",
        manuallyResolvedAt: null,
      },
    ],
  };
}

/**
 * THE ONE CHANGE-SCOPED READ THAT MATCHES ON THE PAYLOAD, not on the anchor -
 * and therefore the one that could see a second ask (#3193 fix round).
 *
 * A second ask is anchored on `ManualRefundTask/<taskId>`, which is what keeps
 * it invisible to every read that decides whether this booking change already
 * has an invoice going out. This read is the exception: it matches
 * `requestPayload.bookingModificationId`, and a second ask carries that id in
 * its payload because the invoice it bills still belongs to that change.
 *
 * Until now nothing but a constant stopped it. A second ask is enqueued with
 * `waitForConfirmedAdditionalPayment: false`, so it is never `WAITING_PAYMENT`
 * and never matched - but that is the wrapper's call-site value, not a property
 * of the anchor, and a future caller flipping it would park an already-settled
 * share's invoice on a PaymentIntent that is already paid, released by nothing
 * and reaped after fourteen days with no invoice raised. That is precisely the
 * shape #3202 exists to fix.
 *
 * `localModel: "BookingModification"` makes it structural instead. It changes
 * nothing for existing rows: an operation anchored on the BOOKING carries a null
 * `bookingModificationId` in its payload, so it never matched this filter
 * anyway. `INV-SSOT` - unrepresentable beats policed.
 */
export function waitingSupplementaryInvoiceOperationsWhere(
  bookingModificationId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    status: "WAITING_PAYMENT",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "BookingModification",
    requestPayload: {
      path: ["bookingModificationId"],
      equals: bookingModificationId,
    },
  };
}

/**
 * The two states in which a queued supplementary invoice has not yet reached
 * Xero, so its amount may still be restated. Named once because the read and the
 * write must use the SAME set - a filter on one and not the other is a
 * check-then-act, which is how a restate came to rewrite an operation the outbox
 * had already moved on (#3170 fix round, F3). Moved here from
 * `xero-operation-outbox.ts` by #3947 with the read below.
 */
export const RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES = [
  "PENDING",
  "WAITING_PAYMENT",
] as const;

/**
 * THE supplementary invoices queued for this anchor that a restate may still
 * raise: the read `restatePendingSupplementaryInvoiceAmount` makes before it
 * writes. Narrower than the enqueue's outstanding set by `RUNNING`, which can
 * no longer be restated; the review charge's route chooser asks the enqueue's
 * wider question instead (#3947 review round 2).
 */
export function restatableSupplementaryInvoiceOperationsWhere({
  localModel,
  localId,
}: {
  localModel: XeroSupplementaryInvoiceAnchorModel;
  localId: string;
}): Prisma.XeroSyncOperationWhereInput {
  return {
    status: { in: [...RESTATABLE_SUPPLEMENTARY_INVOICE_STATUSES] },
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel,
    localId,
    requestPayload: {
      path: ["queueType"],
      equals: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
    },
  };
}
