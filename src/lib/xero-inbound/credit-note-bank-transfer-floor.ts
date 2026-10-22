import { PaymentSource, type Prisma } from "@prisma/client";

import { hasVoidAwaitingFollowUp } from "@/lib/bank-refund-void-scan";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";

/**
 * #4230 (owner decision 22 Oct 2026, `INV-ADDPAY-021`): what the floor's alert
 * tells the officer to do. Below the detail is a real shortfall in Xero, with
 * two causes: a refund that has no credit note of its own (a later refund on a
 * bank-transfer payment can be counted under the payment's first refund note
 * instead of getting its own), or a refund note voided in Xero. The one
 * wording, shown in the alert and quoted by the Xero guide's troubleshooting
 * row, which a test holds to this constant.
 */
export const BANK_TRANSFER_REFUND_SHORTFALL_ADVICE =
  "Either a refund on this payment has no Xero credit note of its own yet - for example a later refund that was counted under the payment's first refund note instead of getting its own - so raise the missing refund credit note by hand in Xero; or a refund credit note was voided in Xero, and the nightly follow-up puts that refund back on the treasurer's refund list to confirm.";

/** The floor's alert, in plain English: the two totals, what was kept, and the advice above. */
export function bankTransferRefundShortfallMessage(input: { paymentId: string; xeroNotesTotal: string; recordedRefundsTotal: string }): string {
  return `The Xero refund credit notes for bank-transfer payment ${input.paymentId} add up to ${input.xeroNotesTotal}, less than the refunds the club recorded on it (${input.recordedRefundsTotal}). The recorded refunds were kept. ${BANK_TRANSFER_REFUND_SHORTFALL_ADVICE}`;
}

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-021`): THE BANK-TRANSFER
 * FLOOR on the inbound credit-note recount (`repairRefundedPaymentBusinessState`).
 *
 * A bank-transfer payment's refunded total is never lowered below its own
 * transaction detail - the hand-backs the treasurer recorded - by what Xero's
 * live notes say. A voided refund note is carried through the detail, the
 * ledger line and the total together by the nightly follow-up
 * (`bank-refund-void-follow-up.ts`, `INV-ADDPAY-042`), never by this recount
 * alone. When Xero shows less, the detail is kept, logged and alerted, as the
 * card floor is (#1353) - at info and with no alert while a voided refund note
 * on the payment waits for that follow-up, which is the expected divergence.
 * The alert names both causes of a shortfall (`BANK_TRANSFER_REFUND_SHORTFALL_ADVICE`).
 * A total already below its detail is never raised here; one above it may
 * still come down to it. Any other source passes through untouched.
 */
export async function floorBankTransferRefundedTotal(input: {
  payment: { id: string; source: PaymentSource; refundedAmountCents: number };
  xeroDerivedCents: number;
  creditNoteId: string;
  format: ClubFormat;
}): Promise<number> {
  const { payment, xeroDerivedCents } = input;
  if (payment.source !== PaymentSource.INTERNET_BANKING || xeroDerivedCents >= payment.refundedAmountCents) return xeroDerivedCents;
  const detail = await prisma.paymentTransaction.aggregate({ where: { paymentId: payment.id }, _sum: { refundedAmountCents: true } });
  const floorCents = Math.min(payment.refundedAmountCents, Math.max(0, detail._sum.refundedAmountCents ?? 0));
  if (xeroDerivedCents >= floorCents) return xeroDerivedCents;
  // A voided refund note the nightly follow-up has not handled yet explains
  // the divergence and resolves it: logged, not alerted (review, security 12).
  if (await hasVoidAwaitingFollowUp(prisma as unknown as Prisma.TransactionClient, payment.id)) {
    logger.info(
      { creditNoteId: input.creditNoteId, paymentId: payment.id, detailCents: floorCents, xeroDerivedRefundedTotalCents: xeroDerivedCents },
      "Bank-transfer refund total kept at its detail while a voided refund note waits for the nightly follow-up (#4162 floor)",
    );
    return floorCents;
  }
  logger.warn(
    {
      creditNoteId: input.creditNoteId,
      paymentId: payment.id,
      localRefundedAmountCents: payment.refundedAmountCents,
      detailCents: floorCents,
      xeroDerivedRefundedTotalCents: xeroDerivedCents,
    },
    "Xero-derived refund total is below the bank-transfer payment's own refund detail; keeping the detail (#4162 floor)",
  );
  await notifyXeroSyncError({
    errorType: "refund-ledger-divergence",
    operation: `inbound-credit-note-repair:${input.creditNoteId}`,
    errorMessage: bankTransferRefundShortfallMessage({
      paymentId: payment.id,
      xeroNotesTotal: formatCents(xeroDerivedCents, input.format),
      recordedRefundsTotal: formatCents(floorCents, input.format),
    }),
  });
  return floorCents;
}
