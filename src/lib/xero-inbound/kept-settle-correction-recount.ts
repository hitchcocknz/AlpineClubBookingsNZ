/**
 * The refunded-total recount a bank-transfer settle owes after it KEEPS the
 * stored figure, or replays one already captured (#4095 items 5 and 12,
 * `INV-PAY-125`, `INV-PAY-126`).
 *
 * An invoice correction counts as refunded only against a receipt recorded at
 * the stored figure. A correction synced before the settle (or whose sync read
 * the payment while it was still uncaptured) found no such receipt and counted
 * nothing; the settle then captured the receipt at the stored figure, which
 * still includes the corrected amount, so the payment's net was overstated by
 * the correction until another note happened to recount it.
 *
 * So after the settle commits, each correction applied to the invoice that has
 * already been synced is recounted here, exactly as its own sync recounts it:
 * its contribution by invoice (`resolveModificationRefundAmountsByPaymentId`),
 * then `repairRefundedPaymentBusinessState`, with its claim on the row it read.
 * A note never synced yet is left to its own sync, which now finds the
 * receipt. Runs after the commit, outside any transaction, and takes no lock of
 * its own. The repair writes an absolute total, so running it again on a replay
 * changes nothing that is already right. A note it could not recount (an error,
 * or a claim lost twice) is returned, and the inbound event fails on it after
 * every other write, so the event is retried and the replay recounts it.
 */
import { CreditNote } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { readNumber } from "@/lib/xero-json";
import { getJsonRecord } from "./amounts";
import { repairRefundedPaymentBusinessState } from "./credit-note-repairs";
import { resolveModificationRefundAmountsByPaymentId } from "./modification-note-refunds";
import type { AppliedCreditNote } from "./settle-from-cash";

export async function recountCorrectionsAfterKeptSettle(
  invoiceId: string,
  correctionNotes: readonly AppliedCreditNote[],
): Promise<string[]> {
  const unrecounted: string[] = [];
  for (const note of correctionNotes) {
    try {
      // The status the note's last sync recorded; none yet means it was never
      // synced, and its own sync will count it.
      const link = await prisma.xeroObjectLink.findFirst({
        where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.id, role: "MODIFICATION_CREDIT_NOTE", active: true },
        select: { metadata: true },
      });
      const metadata = getJsonRecord(link?.metadata);
      const status = metadata?.status;
      if (typeof status !== "string" || !isIncludedRefundCreditNoteStatus(status)) continue;

      const resolve = () =>
        resolveModificationRefundAmountsByPaymentId({
          creditNoteId: note.id,
          isModificationNote: true,
          allocationTargets: [{ invoiceId, amountCents: note.appliedCents }],
        });
      const modificationRefundAmountsByPaymentId = await resolve();
      if (modificationRefundAmountsByPaymentId.size === 0) continue;
      const repair = await repairRefundedPaymentBusinessState({
        creditNoteId: note.id,
        // The recorded status, already found to count; one Xero does not name
        // reads as unknown, which counts too (`isIncludedRefundCreditNoteStatus`).
        creditNote: { status: CreditNote.StatusEnum[status as keyof typeof CreditNote.StatusEnum], total: readNumber(metadata?.total) ?? undefined },
        directPaymentIds: [],
        modificationRefundAmountsByPaymentId,
        recomputeModificationRefundAmounts: resolve,
      });
      if (repair.unsettledPaymentIds) {
        logger.error(
          { invoiceId, creditNoteId: note.id, paymentIds: repair.unsettledPaymentIds },
          "The recount after a kept bank-transfer settle lost its claim twice; the invoice event fails so it is retried (#4095)",
        );
        unrecounted.push(note.id);
      }
    } catch (err) {
      logger.error(
        { err, invoiceId, creditNoteId: note.id },
        "Could not recount an invoice correction after a kept bank-transfer settle; the invoice event fails so it is retried (#4095)",
      );
      unrecounted.push(note.id);
    }
  }
  return unrecounted;
}
