/**
 * #3980 (review round 1, M2/M3/M5): which edits a primary invoice's worth gap
 * belongs to, read at the gap check.
 *
 * The edits that settled against the primary invoice are marked
 * (`markedPrimaryInvoiceEditsWhere`). From them:
 *
 *  - THE ANCHOR of a shortfall's supplementary invoice ({@link primaryInvoiceGapAnchors},
 *    M3): a marked edit that moved money (a price or fee change) and has no
 *    edit-financial review. A $0 edit explains no gap, and a parked edit's
 *    review later bills its share on a supplementary invoice anchored on that
 *    same edit, which an anchored gap invoice would make read as already
 *    covered - so the review's money would never be billed.
 *  - THE CARD ASK it waits on ({@link anchorCardAsk}, M2): an anchor that asked
 *    the member's card had no invoice to supplement, so its ask settles nothing
 *    in Xero. The gap invoice waits on that ask's payment intent and records
 *    the payment when it lands - released by the capture like any edit's
 *    supplementary invoice - rather than being raised unpaid while the member
 *    pays by card.
 *  - THE RACING REDUCTIONS ({@link racingReductionSettlement}, M5): for an
 *    overcharge, how the reductions that landed mid-create settled their money,
 *    so the treasurer's credit note also accounts for the refund paid out.
 */
import { PaymentTransactionKind } from "@prisma/client";

import { recordedPrimaryInvoiceSettlement, type PrimaryInvoiceEditSettlement } from "@/lib/booking-primary-invoice-claim";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { markedPrimaryInvoiceEditsWhere } from "@/lib/xero-primary-invoice-read";

export type MarkedPrimaryInvoiceEdit = {
  id: string;
  priceDiffCents: number;
  changeFeeCents: number;
  newData: unknown;
};

/** The booking's marked edits, newest first. */
export async function readMarkedPrimaryInvoiceEdits(bookingId: string): Promise<MarkedPrimaryInvoiceEdit[]> {
  return prisma.bookingModification.findMany({
    where: markedPrimaryInvoiceEditsWhere(bookingId),
    orderBy: { createdAt: "desc" },
    select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true },
  });
}

/** The marked edits a shortfall may be anchored on, newest first (M3). */
export async function primaryInvoiceGapAnchors(
  bookingId: string,
  marked: readonly MarkedPrimaryInvoiceEdit[],
): Promise<MarkedPrimaryInvoiceEdit[]> {
  const moved = marked.filter((edit) => edit.priceDiffCents !== 0 || edit.changeFeeCents !== 0);
  if (moved.length === 0) return [];
  const reviews = await prisma.manualRefundTask.findMany({
    where: { bookingId, kind: "EDIT_FINANCIAL_REVIEW" },
    select: { reviewContext: true },
  });
  const reviewed = new Set(
    reviews.flatMap((task) => {
      const id = asRecord(task.reviewContext)?.bookingModificationId;
      return typeof id === "string" ? [id] : [];
    }),
  );
  return moved.filter((edit) => !reviewed.has(edit.id));
}

/**
 * What the anchor's card ask means for its gap invoice (M2), or null where it
 * asked nothing, or its ask was withdrawn: then the gap invoice is raised as
 * before (paid from cash the primary left, else unpaid).
 *
 *  - asked and captured: the invoice records that payment now;
 *  - asked and not yet captured: it waits on the intent;
 *  - asked but the intent is not written yet (the door mints after its commit)
 *    or its mint failed: it waits on no intent, and the door's Xero leg - or
 *    the mint's recovery - attaches the intent once it exists
 *    (`attachPaymentIntentToWaitingSupplementaryInvoiceOperations`).
 */
export async function anchorCardAsk(
  bookingId: string,
  anchor: MarkedPrimaryInvoiceEdit,
): Promise<{ paymentIntentId: string | null; captured: boolean } | null> {
  const settlement = recordedPrimaryInvoiceSettlement(anchor.newData);
  if (!settlement || settlement.cardAskCents <= 0) return null;
  const ask = await readAnchorAsk(bookingId, anchor.id);
  if (ask?.withdrawnAt) return null;
  if (!ask?.stripePaymentIntentId || ask.status === "FAILED") return { paymentIntentId: null, captured: false };
  const captured = ask.status !== "PENDING" && ask.status !== "PROCESSING";
  return { paymentIntentId: ask.stripePaymentIntentId, captured };
}

/** The anchor's newest card ask row: the door stamps its edit on the row it mints. */
export async function readAnchorAsk(bookingId: string, bookingModificationId: string) {
  return prisma.paymentTransaction.findFirst({
    where: { payment: { bookingId }, kind: PaymentTransactionKind.ADDITIONAL, bookingModificationId },
    orderBy: { createdAt: "desc" },
    select: { stripePaymentIntentId: true, status: true, withdrawnAt: true },
  });
}

/**
 * How the reductions behind an overcharge settled their money (M5): the marked
 * reductions the create's snapshot did not hold - the ones that landed
 * mid-create - or, where the snapshot held them all (a replayed create handed
 * the original invoice back), every marked reduction.
 */
export function racingReductionSettlement(
  marked: readonly MarkedPrimaryInvoiceEdit[],
  markedAtBuild: readonly string[] | undefined,
): { modificationIds: string[]; settledBy: Omit<PrimaryInvoiceEditSettlement, "cardAskCents"> } {
  const reductions = marked.filter((edit) => edit.priceDiffCents + edit.changeFeeCents < 0);
  const known = new Set(markedAtBuild ?? []);
  const racing = reductions.filter((edit) => !known.has(edit.id));
  const chosen = racing.length > 0 ? racing : reductions;
  const settledBy = { refundAmountCents: 0, accountCreditAmountCents: 0, appliedCreditGivenBackCents: 0, unpaidAskOffsetCents: 0 };
  for (const edit of chosen) {
    const recorded = recordedPrimaryInvoiceSettlement(edit.newData);
    if (!recorded) continue;
    settledBy.refundAmountCents += recorded.refundAmountCents;
    settledBy.accountCreditAmountCents += recorded.accountCreditAmountCents;
    settledBy.appliedCreditGivenBackCents += recorded.appliedCreditGivenBackCents;
    settledBy.unpaidAskOffsetCents += recorded.unpaidAskOffsetCents;
  }
  return { modificationIds: chosen.map((edit) => edit.id), settledBy };
}
