/**
 * #3953 (`INV-PAY-138`): WHEN A CHANGE CAPTURE'S RECEIPT MAY PLAN - its waits
 * and the planning gate (review rounds 1, 3 and 4), split from the worker
 * (`additional-capture-xero-receipt.ts`) so the outbox's scan reads the wait
 * spacing without the worker's import graph.
 */
import { prisma } from "@/lib/prisma";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { liveRunningXeroOperationFilter } from "@/lib/xero-stale-operations";
import { XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE } from "@/lib/additional-capture-receipt-payload";
import { asRecord } from "@/lib/xero-json";
import { sanitizeForJson } from "@/lib/xero-sync";

/** The `lastErrorCode` a receipt carries while it waits (busy) and goes back to PENDING. */
export const ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE = "ADDITIONAL_CAPTURE_RECEIPT_WAITING";

/**
 * A wait: the applied-credit busy error, so the outbox returns the row to
 * PENDING with this code rather than failing it. Built at the throw, never
 * subclassed at module load.
 */
export function waitFor(message: string): XeroAppliedCreditOperationBusyError {
  return new XeroAppliedCreditOperationBusyError(message, null, ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE);
}

/** Round 4: stamped on a RUNNING receipt that has passed the planning gate, until it finishes or waits. */
export const ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE = "ADDITIONAL_CAPTURE_RECEIPT_PLANNING";

/**
 * Review round 1 (D), round 4: ONE RECEIPT PLANS PER BOOKING AT A TIME, and
 * none while the booking's invoice create runs - its link save queues
 * receipts and its gap check decides what the gap invoice pays itself from.
 *
 * THE GATE. Under the per-anchor supplementary-invoice lock on the booking
 * (`lockSupplementaryInvoiceAnchor`, an anchor that lock already serialises;
 * no new key), the receipt looks for another LIVE receipt on the booking that
 * has passed the gate (`ADDITIONAL_CAPTURE_RECEIPT_PLANNING`), and either
 * waits for it or stamps its own row with that code, guarded on its status,
 * and goes on. Whichever takes the lock second sees the first's stamp, so
 * exactly one passes - whatever order the outbox's claims committed in, and
 * with no both-wait to break (round 3's `(startedAt, id)` order read the
 * app's clock, not commit order). The lock is held for the milliseconds of
 * that check and stamp; no provider call runs under it (`INV-LOCK-004`).
 * The stamp ends with the row: a wait, a failure or a refusal writes its own
 * code, a success clears it, and a dead row stops counting once it is past
 * the staleness threshold (`liveRunningXeroOperationFilter`).
 */
export async function passPlanningGate(operationId: string, bookingId: string): Promise<void> {
  const live = liveRunningXeroOperationFilter();
  const runningCreate = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      ...live,
    },
    select: { id: true },
  });
  if (runningCreate) {
    throw waitFor(`The booking's Xero invoice is still being raised (operation ${runningCreate.id}); this card payment is recorded once it is done`);
  }
  // Imported here: the outbox dispatches to this worker.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  const otherId = await prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, bookingId);
    const other = await tx.xeroSyncOperation.findFirst({
      where: {
        id: { not: operationId },
        queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
        requestPayload: { path: ["bookingId"], equals: bookingId },
        lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE,
        ...live,
      },
      select: { id: true },
    });
    if (other) return other.id;
    await tx.xeroSyncOperation.updateMany({
      where: { id: operationId, status: "RUNNING" },
      data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_PLANNING_CODE },
    });
    return null;
  });
  if (otherId) {
    throw waitFor(`Another card payment receipt for this booking (operation ${otherId}) is being recorded; this one waits for it`);
  }
}

/** Round 3: how long a waiting receipt is left out of the outbox scan before it is looked at again. */
export const ADDITIONAL_CAPTURE_RECEIPT_RECHECK_MS = 60 * 1000;

/**
 * Round 3: the outbox scan's filter - leave out a receipt returned to wait
 * until its recheck is due, so it does not take the head of every kick, as
 * `outboxScanLeavesAwaitingOwnNote` does for a waiting note. Every other row,
 * a null code included, is scanned as before.
 */
export function outboxScanSpacesWaitingReceipts(now: Date) {
  return {
    OR: [
      { lastErrorCode: null },
      { lastErrorCode: { not: ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE } },
      { updatedAt: { lte: new Date(now.getTime() - ADDITIONAL_CAPTURE_RECEIPT_RECHECK_MS) } },
    ],
  };
}

/**
 * #3953 review round 6 (item 2): a receipt whose own payment is in Xero found
 * another supplementary invoice that would record the same capture. Where that
 * invoice has not sent - PENDING, WAITING_PAYMENT, or FAILED with no active
 * `SUPPLEMENTARY_INVOICE` link - it is switched to raise UNPAID, under its
 * anchor's lock and guarded on the status read there, so the capture is
 * recorded once. Returns whether it was switched; one in Xero, or being sent,
 * is left (the caller tells an officer either way). Its own transaction,
 * holding no other key; no Xero call.
 */
export async function switchUnsentRecorderUnpaid(supplementaryOperationId: string): Promise<boolean> {
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: supplementaryOperationId },
    select: { status: true, localModel: true, localId: true },
  });
  if (!row?.localModel || !row.localId || !["PENDING", "WAITING_PAYMENT", "FAILED"].includes(row.status)) return false;
  const { localModel, localId } = row;
  const linked = await prisma.xeroObjectLink.findFirst({
    where: { localModel, localId, xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true },
    select: { id: true },
  });
  if (linked) return false;
  // Imported here: the outbox dispatches to the receipt's worker.
  const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, localId);
    const current = await tx.xeroSyncOperation.findUnique({
      where: { id: supplementaryOperationId },
      select: { status: true, requestPayload: true },
    });
    if (!current || current.status !== row.status) return false;
    const result = await tx.xeroSyncOperation.updateMany({
      where: { id: supplementaryOperationId, status: current.status },
      data: { requestPayload: sanitizeForJson({ ...(asRecord(current.requestPayload) ?? {}), recordPayment: false }) },
    });
    return result.count === 1;
  });
}
