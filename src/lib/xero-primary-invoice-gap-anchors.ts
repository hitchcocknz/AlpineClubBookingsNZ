/**
 * #3980 (review rounds 1 and 2): which edits a primary invoice's worth gap
 * belongs to, read at the gap check.
 *
 * The edits that settled against the primary invoice are marked
 * (`markedPrimaryInvoiceEditsWhere`). From them:
 *
 *  - THE RACING EDITS ({@link racingMarkedEdits}, round 2 F1): the marked edits
 *    the create's snapshot did not hold (`markedModificationIdsAtBuild`) - the
 *    ones that landed while it was in flight. An edit the snapshot held is
 *    already on the primary invoice's lines; anchoring a gap on it would bill a
 *    re-base's or a school naming's money (writers that mark nothing) as that
 *    old edit's, and record its long-captured ask as paying for it. Where the
 *    create's operation is a replay of an earlier one (`replayCutoff`), an edit
 *    made before that earlier operation is no racing edit either.
 *  - THE ANCHOR of a shortfall's supplementary invoice
 *    ({@link primaryInvoiceGapAnchors}): a racing edit that moved money and has
 *    no edit-financial review. A $0 edit explains no gap, and a reviewed edit's
 *    review bills its share on a supplementary invoice anchored on that same
 *    edit (round 1 M3).
 *  - THE CARD ASK it waits on ({@link classifyAnchorAsk}, round 1 M2 and round
 *    2 F1/F5): one predicate for the gap check's read and its locked re-check.
 *  - THE RACING REDUCTIONS ({@link racingReductionSettlement}): how the
 *    reductions behind an overcharge settled, so the treasurer accounts for any
 *    refund paid out. None when no reduction landed mid-create (round 2 M3).
 */
import { PaymentTransactionKind, type PaymentStatus, type Prisma } from "@prisma/client";

import { LEDGER_ROWS_NEWEST_FIRST } from "@/lib/payment-ledger-order";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { recordedPrimaryInvoiceSettlement, type PrimaryInvoiceEditSettlement } from "@/lib/booking-primary-invoice-claim";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { markedPrimaryInvoiceEditsWhere } from "@/lib/xero-primary-invoice-read";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";

export type MarkedPrimaryInvoiceEdit = {
  id: string;
  priceDiffCents: number;
  changeFeeCents: number;
  newData: unknown;
  createdAt: Date;
};

/** The booking's marked edits, newest first. */
export async function readMarkedPrimaryInvoiceEdits(bookingId: string): Promise<MarkedPrimaryInvoiceEdit[]> {
  return prisma.bookingModification.findMany({
    where: markedPrimaryInvoiceEditsWhere(bookingId),
    orderBy: { createdAt: "desc" },
    select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
  });
}

/**
 * When the operation that stored these figures is a REPLAY - not the booking's
 * first invoice create operation - when that first one was made: an edit made
 * before it was read by the create that Xero's invoice came from. Null for a
 * first create, or when the figures' operation is not known.
 */
export async function primaryInvoiceReplayCutoff(
  bookingId: string,
  figuresOperationId: string | undefined,
): Promise<Date | null> {
  if (!figuresOperationId) return null;
  const first = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
  return first && first.id !== figuresOperationId ? first.createdAt : null;
}

/**
 * The marked edits that landed while the create was in flight: not in its
 * snapshot, and not before the operation it replays. A record written before
 * the snapshot existed (`markedAtBuild` undefined) cannot tell, so every marked
 * edit counts, as before.
 */
export function racingMarkedEdits(
  marked: readonly MarkedPrimaryInvoiceEdit[],
  markedAtBuild: readonly string[] | undefined,
  replayCutoff: Date | null,
): MarkedPrimaryInvoiceEdit[] {
  const known = new Set(markedAtBuild ?? []);
  return marked.filter(
    (edit) => !known.has(edit.id) && (replayCutoff === null || edit.createdAt >= replayCutoff),
  );
}

/** The racing edits a shortfall may be anchored on, newest first. */
export async function primaryInvoiceGapAnchors(
  bookingId: string,
  racing: readonly MarkedPrimaryInvoiceEdit[],
): Promise<MarkedPrimaryInvoiceEdit[]> {
  const moved = racing.filter((edit) => edit.priceDiffCents !== 0 || edit.changeFeeCents !== 0);
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

export type AnchorAskRow = {
  stripePaymentIntentId: string | null;
  status: PaymentStatus;
  withdrawnAt: Date | null;
  amountCents: number;
  carriedAskCents: number;
};

/**
 * THE ONE READING of an anchor's card ask (round 2 F5), for the gap check's
 * read and for its locked re-check alike:
 *
 *  - `none`: it asked nothing, or nothing large enough - the ask's own money
 *    (less what it carried from earlier asks) does not cover the gap, so
 *    recording its capture against the gap invoice would book cash that never
 *    came for it (round 2 F2);
 *  - `dead`: withdrawn, retired by a reduction, or declined (FAILED);
 *  - `unminted`: asked, but no row yet - the door mints after its commit;
 *  - `pending` / `captured`: a live intent, not yet or already paid.
 */
export type AnchorAsk =
  | { kind: "none" }
  | { kind: "dead" }
  | { kind: "unminted" }
  | { kind: "pending"; paymentIntentId: string }
  | { kind: "captured"; paymentIntentId: string };

export function classifyAnchorAsk(input: {
  anchor: MarkedPrimaryInvoiceEdit;
  row: AnchorAskRow | null;
  gapCents: number;
}): AnchorAsk {
  const settlement = recordedPrimaryInvoiceSettlement(input.anchor.newData);
  if (!settlement || settlement.cardAskCents <= 0) return { kind: "none" };
  const row = input.row;
  if (!row) return settlement.cardAskCents >= input.gapCents ? { kind: "unminted" } : { kind: "none" };
  if (row.withdrawnAt || row.status === "FAILED" || !row.stripePaymentIntentId) return { kind: "dead" };
  if (row.amountCents - row.carriedAskCents < input.gapCents) return { kind: "none" };
  return isCapturedTransactionStatus(row.status)
    ? { kind: "captured", paymentIntentId: row.stripePaymentIntentId }
    : { kind: "pending", paymentIntentId: row.stripePaymentIntentId };
}

/** The anchor's newest card ask row: the door stamps its edit on the row it mints. */
export async function readAnchorAsk(
  db: Pick<Prisma.TransactionClient, "paymentTransaction">,
  bookingId: string,
  bookingModificationId: string,
): Promise<AnchorAskRow | null> {
  return db.paymentTransaction.findFirst({
    where: { payment: { bookingId }, kind: PaymentTransactionKind.ADDITIONAL, bookingModificationId },
    orderBy: [...LEDGER_ROWS_NEWEST_FIRST],
    select: { stripePaymentIntentId: true, status: true, withdrawnAt: true, amountCents: true, carriedAskCents: true },
  });
}

/**
 * How the reductions behind an overcharge settled (round 1 M5): the racing
 * reductions only. Null when none landed mid-create - then the overcharge has
 * another cause (a replayed invoice, a writer that marks nothing) and the task
 * says nothing about a settlement (round 2 M3).
 */
export function racingReductionSettlement(
  racing: readonly MarkedPrimaryInvoiceEdit[],
): { modificationIds: string[]; settledBy: Omit<PrimaryInvoiceEditSettlement, "cardAskCents"> } | null {
  const reductions = racing.filter((edit) => edit.priceDiffCents + edit.changeFeeCents < 0);
  if (reductions.length === 0) return null;
  const settledBy = { refundAmountCents: 0, accountCreditAmountCents: 0, appliedCreditGivenBackCents: 0, unpaidAskOffsetCents: 0 };
  for (const edit of reductions) {
    const recorded = recordedPrimaryInvoiceSettlement(edit.newData);
    if (!recorded) continue;
    settledBy.refundAmountCents += recorded.refundAmountCents;
    settledBy.accountCreditAmountCents += recorded.accountCreditAmountCents;
    settledBy.appliedCreditGivenBackCents += recorded.appliedCreditGivenBackCents;
    settledBy.unpaidAskOffsetCents += recorded.unpaidAskOffsetCents;
  }
  return { modificationIds: reductions.map((edit) => edit.id), settledBy };
}
