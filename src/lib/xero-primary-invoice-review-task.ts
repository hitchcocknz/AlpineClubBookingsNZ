/**
 * #3980 (owner decision, 21 Oct 2026: "refuse, and bill the gap"): the Xero
 * Operations task a treasurer gets when a booking's primary Xero invoice does
 * not bill what the booking was worth when its link was saved, and the gap
 * cannot be billed automatically.
 *
 *  - OVERBILLED: the invoice bills MORE than the booking is worth - an edit
 *    lowered the price after the create read the booking. No credit note is
 *    raised automatically (not taken by the owner); the treasurer decides.
 *  - UNDERBILLED: it bills LESS, and no edit that settled against the primary
 *    invoice is there to anchor a supplementary invoice on, so nothing can be
 *    billed without a person.
 *
 * THE TASK IS A `XeroSyncOperation` ROW, written FAILED and not replayable, so
 * it shows in the Xero Operations panel as an active failure with its message,
 * Retry refuses it ("not marked replayable"), and the treasurer closes it with
 * "Resolved in Xero" once they have acted (`INV-INT-025`). No provider call is
 * made and no migration is needed: `status` and the type columns are text.
 *
 * Its types are its own (`entityType` `REVIEW`) so no invoice, credit-note or
 * repair query mistakes it for a document's operation, and its correlation key
 * is its own, so it neither dedups against nor is counted with the create. It
 * is anchored on the booking (`localModel` `Booking`) so the booking shows it.
 * One per invoice and direction: a re-run of the check finds the first and
 * raises no second.
 */
import type { ClubFormat } from "@/lib/club-format";
import { getClubFormat } from "@/lib/club-format-settings";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { sanitizeForJson } from "@/lib/xero-sync";

export const PRIMARY_INVOICE_REVIEW_ENTITY_TYPE = "REVIEW";
export const PRIMARY_INVOICE_REVIEW_OPERATION_TYPE = "PRIMARY_INVOICE_WORTH_GAP";

export type PrimaryInvoiceReviewKind = "OVERBILLED" | "UNDERBILLED";

/** The task's own key: one per booking, invoice and direction. */
export function primaryInvoiceReviewCorrelationKey(input: {
  bookingId: string;
  xeroInvoiceId: string;
  kind: PrimaryInvoiceReviewKind;
}): string {
  return `primary-invoice-review:${input.kind.toLowerCase()}:${input.bookingId}:${input.xeroInvoiceId}`;
}

/** What the treasurer reads in the panel. Plain figures, no member details. */
export function primaryInvoiceReviewMessage(
  input: {
    kind: PrimaryInvoiceReviewKind;
    bookingId: string;
    gapCents: number;
  },
  format: ClubFormat,
): string {
  const reference = `Booking ${input.bookingId.slice(0, 8)}`;
  const amount = formatCents(Math.abs(input.gapCents), format);
  return input.kind === "OVERBILLED"
    ? `The primary Xero invoice for ${reference} bills ${amount} more than the booking is worth: the booking was changed while the invoice was being raised. Check the invoice and raise a credit note for ${amount} in Xero if one is due, then mark this resolved.`
    : `The primary Xero invoice for ${reference} bills ${amount} less than the booking is worth: the booking was changed while the invoice was being raised, and no change could carry the difference. Check the invoice and bill ${amount} in Xero if it is due, then mark this resolved.`;
}

/**
 * Raises the task, or finds the one an earlier run raised. Returns its id.
 * Two runs racing past the lookup could each write one; the panel groups rows
 * by correlation key and shows the latest, so a duplicate reads as one task.
 */
export async function raisePrimaryInvoiceReviewTask(input: {
  kind: PrimaryInvoiceReviewKind;
  bookingId: string;
  xeroInvoiceId: string;
  gapCents: number;
  figures: Record<string, unknown>;
  createdByMemberId?: string;
}): Promise<{ operationId: string; alreadyRaised: boolean }> {
  const correlationKey = primaryInvoiceReviewCorrelationKey(input);
  const existing = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      entityType: PRIMARY_INVOICE_REVIEW_ENTITY_TYPE,
      operationType: PRIMARY_INVOICE_REVIEW_OPERATION_TYPE,
    },
    select: { id: true },
  });
  if (existing) return { operationId: existing.id, alreadyRaised: true };

  const now = new Date();
  const created = await prisma.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: PRIMARY_INVOICE_REVIEW_ENTITY_TYPE,
      operationType: PRIMARY_INVOICE_REVIEW_OPERATION_TYPE,
      localModel: "Booking",
      localId: input.bookingId,
      status: "FAILED",
      correlationKey,
      replayable: false,
      lastErrorCode: `PRIMARY_INVOICE_${input.kind}`,
      lastErrorMessage: primaryInvoiceReviewMessage(input, await getClubFormat()),
      requestPayload: sanitizeForJson({
        kind: input.kind,
        bookingId: input.bookingId,
        xeroInvoiceId: input.xeroInvoiceId,
        gapCents: input.gapCents,
        ...input.figures,
      }),
      createdByMemberId: input.createdByMemberId ?? null,
      startedAt: now,
      completedAt: now,
    },
    select: { id: true },
  });
  return { operationId: created.id, alreadyRaised: false };
}
