/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): WHAT A VOIDED
 * BANK-TRANSFER REFUND NOTE CALLS FOR. A read-only classifier, shared by the
 * nightly writer (`bank-refund-void-follow-up.ts`, under its locks, on its
 * transaction), the report-only run, the Stuck States list of notes a person
 * must answer, and the owner's count script (`scripts/bank-refund-void-count.ts`).
 * One answer for all four, so the count the owner reads is the work the job
 * then does.
 *
 * THE POPULATION: refund-note links (`REFUND_CREDIT_NOTE`, never an edit's,
 * an account-credit's or a refund request's note) on `INTERNET_BANKING`
 * payments whose recorded Xero status is VOIDED or DELETED.
 *
 * THE ANSWERS, in the order they are asked:
 * - `awaiting-heal`: the mirror is still ACTIVE. #4161's nightly heal turns it
 *   off first; the job runs after it.
 * - `handled`: its follow-up exists (the occurrence key is the claim), or a
 *   marker on the link records it was a spare or answered by a person.
 * - `deferred`: a refund-note create on the payment could still mint
 *   (`findBlockingRefundCreditNoteOperationId`), so coverage may yet move.
 * - `unmatched`: the note's amount cannot be read, the payment's ledger holds
 *   no single live hand-back line for it, or its detail no longer holds it. A
 *   person answers it on Stuck States; nothing moves.
 * - `spare`: the payment's live refund notes, plus notes resolved by hand in
 *   Xero (`INV-INT-025`), still cover all of its bank hand-backs (and its card
 *   refunds), so the voided note was a duplicate and nothing moves.
 * - `undo`: the note recorded one hand-back's refund, which nothing else in
 *   Xero now records. The writer takes it back out of the allocation, reverses
 *   the line, recomputes the total and raises the follow-up.
 *
 * WHICH HAND-BACK A NOTE RECORDED: the task it names - a hand-made note's link
 * (`handBackTaskId`), else its raising row's payload (`handBackTaskId` on a
 * cancellation's note since #4162, `reviewTaskId` on a review's,
 * `paidAnotherWayTaskId` on a follow-up's fresh note) - and that task's live
 * `BANK_REFUND` line for exactly the note's amount. A note naming no task (one
 * raised before #4162) takes the one live hand-back line of its amount on the
 * payment, and only when no other live `BANK_REFUND` line on the booking has
 * that amount; otherwise it is ambiguous.
 *
 * No lock, no write, no provider call.
 */
import type { PaymentSource, Prisma } from "@prisma/client";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { z } from "zod";

import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { findPostedSettlementLines } from "@/lib/booking-ledger-read";
import type { PostedSettlementLine } from "@/lib/booking-ledger-settlement-posting";
import {
  bankRefundVoidFollowUpOccurrenceKey,
  isEditRefundHandBackTask,
  isRefundRequestHandBackTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { unwindableHandBackCents } from "@/lib/payment-transactions";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { asRecord, readString } from "@/lib/xero-json";
import { findBlockingRefundCreditNoteOperationId } from "@/lib/xero-refund-note-link-repair";
import {
  CANCELLED_CREDIT_NOTE_STATUSES,
  isRefundCreditNoteLinkCancelledInXero,
  readRefundNoteRaisingRow,
  recordedRefundNoteAmountCents,
} from "@/lib/xero-refund-note-status";
import {
  readResolvedRefundCreditNoteCoverage,
  sumRefundCreditNoteCoverageCents,
} from "@/lib/xero-resolved-in-xero-fences";

type Reader = Prisma.TransactionClient;

/** The link metadata key a handled-without-a-follow-up marker lives under. */
export const BANK_REFUND_VOID_MARKER_KEY = "bankRefundVoid";

/** Why a voided note was handled with no follow-up: a spare, or answered by a person on Stuck States. */
export type BankRefundVoidMarkerOutcome = "spare" | "answered";

export interface BankRefundVoidMarker {
  outcome: BankRefundVoidMarkerOutcome;
  at: string;
  memberId?: string | null;
  note?: string | null;
}

/** The marker a link carries, or null. */
export function readBankRefundVoidMarker(metadata: unknown): BankRefundVoidMarker | null {
  const marker = asRecord(asRecord(metadata)?.[BANK_REFUND_VOID_MARKER_KEY]);
  const outcome = readString(marker?.outcome);
  const at = readString(marker?.at);
  if ((outcome !== "spare" && outcome !== "answered") || !at) return null;
  return {
    outcome,
    at,
    memberId: readString(marker?.memberId),
    note: readString(marker?.note),
  };
}

const CANDIDATE_ROW = z.object({ id: z.string() });

/**
 * The ids of the refund-note links on bank-transfer payments whose recorded
 * status is VOIDED or DELETED, read the way `readRefundCreditNoteLinkStatus`
 * reads it (trimmed, any case), oldest write first. One statement, so neither
 * a status stored in another case nor the card payments' many retired notes
 * are read row by row; each row is re-checked in code (`classify…`).
 */
export async function readVoidedBankRefundNoteLinkIds(db: Pick<Reader, "$queryRaw">): Promise<string[]> {
  const rows = await db.$queryRaw`
    SELECT l."id"
    FROM "XeroObjectLink" l
    JOIN "Payment" p ON p."id" = l."localId"
    WHERE l."localModel" = 'Payment'
      AND l."xeroObjectType" = 'CREDIT_NOTE'
      AND l."role" = 'REFUND_CREDIT_NOTE'
      AND upper(btrim(l."metadata"->>'status')) IN (${PrismaRuntime.join([...CANCELLED_CREDIT_NOTE_STATUSES])})
      AND p."source" = 'INTERNET_BANKING'
    ORDER BY l."updatedAt" ASC, l."id" ASC
  `;
  return decodeRawRows(rows, CANDIDATE_ROW, "voided bank-transfer refund notes").map((row) => row.id);
}

/** The voided note link's fields every reader here needs. */
export const VOIDED_LINK_SELECT = {
  id: true,
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  role: true,
  active: true,
  metadata: true,
  updatedAt: true,
} as const satisfies Prisma.XeroObjectLinkSelect;

export type VoidedLink = Prisma.XeroObjectLinkGetPayload<{ select: typeof VOIDED_LINK_SELECT }>;

/** Why a voided note goes to a person. */
export type BankRefundVoidUnmatchedReason = "amount-unknown" | "no-line" | "ambiguous" | "detail-short";

/** What the payment looks like beside the void, for the count and the job's log. */
export interface BankRefundVoidPaymentFigures {
  /** `Payment.refundedAmountCents`. */
  refundedCents: number;
  /** What its transactions record as refunded: the detail. */
  detailCents: number;
}

export type BankRefundVoidClassification =
  | { kind: "not-in-scope" }
  | { kind: "awaiting-heal" }
  | { kind: "handled"; by: "follow-up" | BankRefundVoidMarkerOutcome; followUpTaskId: string | null }
  | { kind: "deferred"; blockingOperationId: string }
  | { kind: "unmatched"; reason: BankRefundVoidUnmatchedReason; amountCents: number | null }
  | { kind: "spare"; amountCents: number; coverageCents: number; requiredCents: number }
  | {
      kind: "undo";
      amountCents: number;
      /** The completed hand-back whose refund the note recorded. */
      taskId: string;
      /** That hand-back's live `BANK_REFUND` line, which the undo reverses. */
      line: PostedSettlementLine;
    };

export interface ClassifiedVoidedNote {
  link: VoidedLink;
  paymentId: string;
  bookingId: string | null;
  lodgeId: string | null;
  figures: BankRefundVoidPaymentFigures | null;
  classification: BankRefundVoidClassification;
}

/** The completed tasks on the payment whose refunds a REFUND_CREDIT_NOTE records. */
async function refundNoteHandBackTaskIds(db: Reader, paymentId: string): Promise<Set<string>> {
  const tasks =
    (await db.manualRefundTask.findMany({
      where: { paymentId, status: "COMPLETED", kind: { in: ["CANCELLED_BOOKING_HAND_BACK", "EDIT_FINANCIAL_REVIEW"] } },
      select: { id: true, kind: true, occurrenceKey: true },
    })) ?? [];
  const reviewIds = tasks.filter((task) => task.kind === "EDIT_FINANCIAL_REVIEW").map((task) => task.id);
  // A review's hand-back is recorded by a refund note only on a cancelled
  // booking (#3880); its note row names the review, which is the evidence.
  const notedReviewIds = new Set<string>();
  if (reviewIds.length > 0) {
    const rows =
      (await db.xeroSyncOperation.findMany({
        where: {
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: paymentId,
          OR: reviewIds.map((id) => ({ requestPayload: { path: ["reviewTaskId"], equals: id } })),
        },
        select: { requestPayload: true },
      })) ?? [];
    for (const row of rows) {
      const id = readString(asRecord(row.requestPayload)?.reviewTaskId);
      if (id) notedReviewIds.add(id);
    }
  }
  return new Set(
    tasks
      .filter((task) =>
        task.kind === "EDIT_FINANCIAL_REVIEW"
          ? notedReviewIds.has(task.id)
          : !isEditRefundHandBackTask(task) && !isRefundRequestHandBackTask(task),
      )
      .map((task) => task.id),
  );
}

/** The task a note names as the hand-back it records, or null (a note from before #4162). */
async function noteHandBackTaskId(db: Reader, paymentId: string, link: VoidedLink): Promise<string | null> {
  const onLink = readString(asRecord(link.metadata)?.handBackTaskId);
  if (onLink) return onLink;
  const payload = asRecord((await readRefundNoteRaisingRow(paymentId, link.xeroObjectId, db))?.requestPayload);
  return (
    readString(payload?.handBackTaskId) ??
    readString(payload?.reviewTaskId) ??
    readString(payload?.paidAnotherWayTaskId)
  );
}

/** The card refunds Stripe recorded on the payment: what its card notes, if any, answer. */
async function recordedCardRefundCents(db: Reader, paymentId: string): Promise<number> {
  const refunds = (await db.paymentRefund.findMany({ where: { paymentId }, select: { amountCents: true, status: true } })) ?? [];
  return refunds.filter((refund) => isRecordedRefundStatus(refund.status)).reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0);
}

/**
 * Classify one voided note link. Reads with `db`: the writer passes its
 * transaction after `lock(1)` and the Payment row; every other caller the
 * pooled client, as advice.
 */
export async function classifyVoidedBankRefundNote(db: Reader, linkId: string): Promise<ClassifiedVoidedNote | null> {
  const link = await db.xeroObjectLink.findUnique({ where: { id: linkId }, select: VOIDED_LINK_SELECT });
  if (!link || link.localModel !== "Payment") return null;
  const paymentId = link.localId;
  const result = (classification: BankRefundVoidClassification, extra?: Partial<ClassifiedVoidedNote>): ClassifiedVoidedNote => ({
    link,
    paymentId,
    bookingId: null,
    lodgeId: null,
    figures: null,
    classification,
    ...extra,
  });
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { source: true, refundedAmountCents: true, bookingId: true, booking: { select: { lodgeId: true } } },
  });
  if (
    !payment ||
    payment.source !== ("INTERNET_BANKING" satisfies PaymentSource) ||
    link.xeroObjectType !== "CREDIT_NOTE" ||
    link.role !== "REFUND_CREDIT_NOTE" ||
    !isRefundCreditNoteLinkCancelledInXero(link.metadata)
  ) {
    return result({ kind: "not-in-scope" });
  }
  const detail = await db.paymentTransaction.aggregate({ where: { paymentId }, _sum: { refundedAmountCents: true } });
  const base: Partial<ClassifiedVoidedNote> = {
    bookingId: payment.bookingId,
    lodgeId: payment.booking.lodgeId,
    figures: { refundedCents: payment.refundedAmountCents, detailCents: Math.max(0, detail._sum.refundedAmountCents ?? 0) },
  };
  if (link.active) return result({ kind: "awaiting-heal" }, base);

  const followUp = await db.manualRefundTask.findUnique({
    where: { occurrenceKey: bankRefundVoidFollowUpOccurrenceKey(paymentId, link.xeroObjectId) },
    select: { id: true },
  });
  if (followUp) return result({ kind: "handled", by: "follow-up", followUpTaskId: followUp.id }, base);
  const marker = readBankRefundVoidMarker(link.metadata);
  if (marker) return result({ kind: "handled", by: marker.outcome, followUpTaskId: null }, base);

  const blockingOperationId = await findBlockingRefundCreditNoteOperationId(paymentId, db);
  if (blockingOperationId) return result({ kind: "deferred", blockingOperationId }, base);

  const recorded = await recordedRefundNoteAmountCents(paymentId, link, db);
  const amountCents = recorded !== null && Number.isSafeInteger(recorded) && recorded > 0 ? recorded : null;
  if (amountCents === null) return result({ kind: "unmatched", reason: "amount-unknown", amountCents: null }, base);

  const handBackTaskIds = await refundNoteHandBackTaskIds(db, paymentId);
  const bankRefundLines = liveLines(await findPostedSettlementLines(db, payment.bookingId, { kind: "BANK_REFUND" }));
  const handBackLines = bankRefundLines.filter((line) => line.anchorKind === "REVIEW_TASK" && handBackTaskIds.has(line.anchorId));
  const lineCents = (line: PostedSettlementLine) => -line.sign * line.unitCents * line.quantity;
  const handBackCents = handBackLines.reduce((sum, line) => sum + lineCents(line), 0);

  // The spare check: Xero still records every bank hand-back (and card refund).
  const resolved = await readResolvedRefundCreditNoteCoverage(paymentId, db);
  const coverageCents = await sumRefundCreditNoteCoverageCents(paymentId, resolved, db);
  const requiredCents = handBackCents + (await recordedCardRefundCents(db, paymentId));
  if (handBackCents > 0 && coverageCents >= requiredCents) {
    return result({ kind: "spare", amountCents, coverageCents, requiredCents }, base);
  }

  const taskId = await noteHandBackTaskId(db, paymentId, link);
  const sameAmount = (line: PostedSettlementLine) => lineCents(line) === amountCents;
  const candidates = handBackLines.filter((line) => sameAmount(line) && (taskId === null || line.anchorId === taskId));
  // A named task's own line; an unnamed note's only when no other live
  // `BANK_REFUND` line on the booking has its amount.
  const unique = candidates.length === 1 && (taskId !== null || bankRefundLines.filter(sameAmount).length === 1);
  if (!unique) {
    return result({ kind: "unmatched", reason: candidates.length === 0 ? "no-line" : "ambiguous", amountCents }, base);
  }
  const line = candidates[0]!;
  if ((await unwindableHandBackCents(db, paymentId)) < amountCents) {
    return result({ kind: "unmatched", reason: "detail-short", amountCents }, base);
  }
  return result({ kind: "undo", amountCents, taskId: line.anchorId, line }, base);
}
