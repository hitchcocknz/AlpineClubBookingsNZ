/**
 * #4162 (`INV-ADDPAY-042`): A RECORD-AGAIN'S OWN REFUND NOTE.
 *
 * When the treasurer records a voided bank-transfer refund again
 * (`reRecordBankTransferRefund`), one fresh refund credit note is queued for it.
 * That note answers exactly the voided note's recorded amount, which the
 * resolution row holds, and nothing else on the payment. So it is sized from
 * its own record - the resolution's amount less what its OWN notes already
 * cover - never from the payment-wide gap, which an earlier hand-back's note,
 * or a modification note counted in the refunded total, could shrink or swell.
 * It is the same shape as a "Paid another way" close's note
 * (`readPaidAnotherWayCloseShare`, `INV-PAY-122`), over a different record.
 *
 * Its rows are found one way (`reRecordNoteRowsWhere`): by the resolution id
 * every row the note pipeline writes for it carries - the queued payload and the
 * executed one alike - or, once the record-again has committed, by the row it
 * queued (`noteOperationId`), which still finds it after a draining older
 * worker rewrote its payload without the id during a deploy. The enqueue's
 * dedupe, the executor's sizing and key, and the report's "did its note land"
 * all ask that.
 *
 * A pure reader on the caller's client: no lock, no provider call, no write.
 */
import type { Prisma } from "@prisma/client";

import { isPerDeltaRefundNoteLink } from "@/lib/xero-refund-note-status";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";

/** The key parts that scope a refund note to ONE record-again: `re-record:<resolutionId>`. */
export function reRecordKeyParts(resolutionId: string): string[] {
  return ["re-record", resolutionId];
}

/** The refund-note create rows a record-again raised, in any status. */
export function reRecordNoteRowsWhere(
  paymentId: string,
  resolutionId: string,
  noteOperationId?: string | null,
): Prisma.XeroSyncOperationWhereInput {
  const byPayload = { requestPayload: { path: ["reRecordId"], equals: resolutionId } };
  return {
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    ...(noteOperationId ? { OR: [byPayload, { id: noteOperationId }] } : byPayload),
  };
}

export interface ReRecordShare {
  /** The voided note's recorded amount, which the record-again re-raises. */
  amountCents: number;
  /** What the record-again's own notes already cover. */
  coveredCents: number;
  /** What its note still has to raise: never negative. */
  uncoveredCents: number;
  /** The voided note was one of several per-refund notes (#3880), so its replacement is too. */
  perDelta: boolean;
  /** The voided note this record-again answers. */
  voidedCreditNoteId: string;
  /** Its own note rows (`reRecordNoteRowsWhere`). */
  rowsWhere: Prisma.XeroSyncOperationWhereInput;
}

type ShareReader = Pick<Prisma.TransactionClient, "bankRefundVoidResolution" | "xeroObjectLink" | "xeroSyncOperation">;

/**
 * What a record-again's own note still has to raise, or null when the payment
 * has no such record-again. Read by the enqueue and by the note's execution.
 */
export async function readReRecordShare(
  db: ShareReader,
  paymentId: string,
  resolutionId: string,
): Promise<ReRecordShare | null> {
  const resolution = await db.bankRefundVoidResolution.findFirst({
    where: { id: resolutionId, paymentId, outcome: "RE_RECORDED" },
    select: { amountCents: true, voidedCreditNoteId: true, noteOperationId: true },
  });
  if (!resolution) return null;
  const amountCents = Math.max(0, resolution.amountCents);
  const rowsWhere = reRecordNoteRowsWhere(paymentId, resolutionId, resolution.noteOperationId);
  const coveredCents = await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  const voided = await db.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      xeroObjectId: resolution.voidedCreditNoteId,
    },
    select: { metadata: true },
  });
  return {
    amountCents,
    coveredCents,
    uncoveredCents: Math.max(0, amountCents - coveredCents),
    perDelta: voided ? isPerDeltaRefundNoteLink(voided.metadata) : false,
    voidedCreditNoteId: resolution.voidedCreditNoteId,
    rowsWhere,
  };
}
