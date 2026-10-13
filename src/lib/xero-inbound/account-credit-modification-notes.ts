import { prisma } from "@/lib/prisma";
import { readModificationNoteWording, type ModificationNoteWording } from "@/lib/xero-refund-method";
import { isUnpaidAskBilledOffsetNoteScope, queuedReviewTaskId } from "@/lib/xero-review-task-key";
import { getJsonRecord } from "./amounts";

/**
 * The modification credit notes, of these, that moved no cash, so they must not
 * fold into `Payment.refundedAmountCents`. They are allocated against the
 * invoice like a refund's note, but no money left. Read from the note's own
 * outbound operation, which records the wording and scope it was built with:
 *
 * - #3809 (review M2): worded as account credit when raised (`INV-PAY-101`) -
 *   applied credit given back, or a review's share given back;
 * - #3954 (owner decision 10 Oct 2026): a reduction's invoice correction for the
 *   part of its unpaid-ask offset the primary invoice had billed
 *   (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`) - money the member never paid;
 * - #3979 (owner decision 13 Oct 2026, `INV-PAY-124`): any note worded as an
 *   invoice correction (`INV-PAY-116`). The edit words a note so only when it
 *   lowers an invoice nobody had paid - the payment was not captured and no
 *   Stripe refund went back - so the note is a price correction, not a refund.
 *   The wording is recorded on the note's own operation when it is RAISED, so
 *   the answer does not depend on whether the payment was captured by the time
 *   the inbound sync reads it: a note raised before the bank transfer still
 *   refunds nothing once the transfer settles, and a refund raised after it
 *   never carries this wording.
 */
export async function noCashModificationNoteIds(creditNoteIds: string[]): Promise<Set<string>> {
  if (creditNoteIds.length === 0) return new Set();
  const operations = await prisma.xeroSyncOperation.findMany({
    where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: { in: creditNoteIds } },
    select: { xeroObjectId: true, requestPayload: true },
  });
  return new Set(
    operations
      .filter(
        (operation) =>
          isNoCashModificationNoteWording(readModificationNoteWording(getJsonRecord(operation.requestPayload))) ||
          isUnpaidAskBilledOffsetNoteScope(queuedReviewTaskId(operation)),
      )
      .map((operation) => operation.xeroObjectId)
      .filter((id): id is string => id !== null),
  );
}

/** A wording that says no cash went back: account credit kept, or an invoice correction. */
function isNoCashModificationNoteWording(wording: ModificationNoteWording): boolean {
  return wording.refundMethod === "account-credit" || wording.noteWording === "invoice-correction";
}
