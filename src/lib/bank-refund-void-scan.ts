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
 *   (`findBlockingRefundCreditNoteOperationId`, ignoring a row whose note Xero
 *   voided), so coverage may yet move. Listed for a person after 7 days.
 * - `unmatched`: the note's amount cannot be read, the payment's ledger holds
 *   no single live hand-back line for it, its detail no longer holds it, or it
 *   recorded a card refund's record (a "Paid another way" close or shortfall,
 *   whose note the card refund pipeline re-raises). Nothing moves by itself: a
 *   person picks the bank refund it recorded on Stuck States, and the same undo
 *   runs (owner decision 18 Oct 2026, `resolvePickedUndo`).
 * - `spare`: the payment's live refund notes, plus notes resolved by hand in
 *   Xero (`INV-INT-025`, never one whose own note Xero voided), still cover all
 *   of its bank hand-backs and its eligible card refund cash
 *   (`resolveRefundNoteEligibleCash`), so the voided note was a duplicate and
 *   nothing moves.
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
  isCancelCardShortfallTask,
  isCardRefundPaidAnotherWayTask,
  isEditRefundHandBackTask,
  isRefundRequestHandBackTask,
} from "@/lib/manual-refund-task-settlement-rules";
import { BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX, bankRefundVoidFollowUpOccurrenceKey } from "@/lib/bank-refund-void-follow-up-key";
import { readPaidAnotherWayCash } from "@/lib/card-refund-paid-another-way-cash";
import { unwindableHandBackCents } from "@/lib/refund-allocation-unwind";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { asRecord, readString } from "@/lib/xero-json";
import { findBlockingRefundCreditNoteOperationId } from "@/lib/xero-refund-note-link-repair";
import {
  CANCELLED_CREDIT_NOTE_STATUSES,
  isRefundCreditNoteLinkCancelledInXero,
  readRefundNoteRaisingRow,
  recordedRefundNoteAmountCents,
  refundNoteIdSets,
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
 *
 * Handled notes - a follow-up raised under the note's key, or a marker on the
 * link - are left out in SQL unless `includeHandled` (the count reports them),
 * so the nightly run does not re-read every note it ever handled.
 */
export async function readVoidedBankRefundNoteLinkIds(
  db: Pick<Reader, "$queryRaw">,
  options?: { includeHandled?: boolean },
): Promise<string[]> {
  const includeHandled = options?.includeHandled === true;
  const rows = await db.$queryRaw`
    SELECT l."id"
    FROM "XeroObjectLink" l
    JOIN "Payment" p ON p."id" = l."localId"
    WHERE l."localModel" = 'Payment'
      AND l."xeroObjectType" = 'CREDIT_NOTE'
      AND l."role" = 'REFUND_CREDIT_NOTE'
      AND upper(btrim(l."metadata"->>'status')) IN (${PrismaRuntime.join([...CANCELLED_CREDIT_NOTE_STATUSES])})
      AND p."source" = 'INTERNET_BANKING'
      AND (${includeHandled}::boolean OR (
        (l."metadata" -> ${BANK_REFUND_VOID_MARKER_KEY}::text) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ManualRefundTask" t
          WHERE t."occurrenceKey" = ${BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX}::text || p."id" || ':' || l."xeroObjectId"
        )
      ))
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

/**
 * Why a voided note goes to a person. `paid-another-way`: it recorded a card
 * refund the club paid back another way (or a card refund shortfall), whose
 * record and note stay with the card refund pipeline - never undone here.
 * `coverage-unknown`: a note resolved by hand in Xero has no readable amount.
 */
export type BankRefundVoidUnmatchedReason =
  | "amount-unknown"
  | "no-line"
  | "ambiguous"
  | "detail-short"
  | "paid-another-way"
  | "coverage-unknown";

/** What the payment looks like beside the void, for the count and the job's log. */
export interface BankRefundVoidPaymentFigures {
  /** `Payment.refundedAmountCents`. */
  refundedCents: number;
  /** What its transactions record as refunded: the detail. */
  detailCents: number;
}

/** What an undo takes back: the refund, the hand-back it was recorded on, and that hand-back's live line. */
export interface BankRefundVoidUndo {
  amountCents: number;
  taskId: string;
  line: PostedSettlementLine;
}

export type BankRefundVoidClassification =
  | { kind: "not-in-scope" }
  | { kind: "awaiting-heal" }
  | { kind: "handled"; by: "follow-up" | BankRefundVoidMarkerOutcome; followUpTaskId: string | null }
  | { kind: "deferred"; blockingOperationId: string }
  | { kind: "unmatched"; reason: BankRefundVoidUnmatchedReason; amountCents: number | null }
  | { kind: "spare"; amountCents: number; coverageCents: number; requiredCents: number }
  | ({ kind: "undo" } & BankRefundVoidUndo);

export interface ClassifiedVoidedNote {
  link: VoidedLink;
  paymentId: string;
  bookingId: string | null;
  lodgeId: string | null;
  figures: BankRefundVoidPaymentFigures | null;
  classification: BankRefundVoidClassification;
}

/**
 * The completed tasks on the payment whose refunds a REFUND_CREDIT_NOTE
 * records, each marked when it is a card refund's record (a "Paid another
 * way" close or a card refund shortfall): those count as covered refunds in
 * the spare check, but are never undone or picked here.
 */
async function refundNoteHandBackTasks(db: Reader, paymentId: string): Promise<Map<string, { cardRecord: boolean }>> {
  const tasks =
    (await db.manualRefundTask.findMany({
      // Every completed task on the payment, sorted by kind below: a hand-back's
      // that is no edit's or refund request's (their notes are another role),
      // and a review's whose refund a refund note recorded.
      where: { paymentId, status: "COMPLETED" },
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
  const out = new Map<string, { cardRecord: boolean }>();
  for (const task of tasks) {
    const counts =
      task.kind === "EDIT_FINANCIAL_REVIEW"
        ? notedReviewIds.has(task.id)
        : task.kind === "CANCELLED_BOOKING_HAND_BACK" && !isEditRefundHandBackTask(task) && !isRefundRequestHandBackTask(task);
    if (counts) out.set(task.id, { cardRecord: isCardRefundPaidAnotherWayTask(task) || isCancelCardShortfallTask(task) });
  }
  return out;
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

/**
 * The card refund cash the payment's refund notes must also cover: the
 * canonical eligible cash (`resolveRefundNoteEligibleCash`, which leaves out
 * late-capture refunds Xero never received, `INV-PAY-110`) less the
 * paid-another-way cash it counts, which the hand-back lines already count.
 * Only on the provider ledger: with no refund rows the evidence is the
 * mirror, which on a bank transfer is the hand-backs themselves.
 */
async function cardRefundCashCents(db: Reader, payment: { id: string; bookingId: string; refundedAmountCents: number }): Promise<number> {
  const eligible = await resolveRefundNoteEligibleCash(payment, db);
  if (eligible.evidence.source !== "provider-ledger") return 0;
  const paidAnotherWay = await readPaidAnotherWayCash(db, payment.id);
  return Math.max(0, eligible.eligibleCashCents - paidAnotherWay.notedCents);
}

/** A live hand-back line a person may pick as the one a voided note recorded, with what the treasurer sees of it. */
export interface PickableHandBackLine {
  lineId: string;
  taskId: string;
  amountCents: number;
}

interface PaymentHandBacks {
  /** Every live `BANK_REFUND` line on the booking. */
  bankRefundLines: PostedSettlementLine[];
  /** Those on the payment's refund-note hand-backs. */
  handBackLines: PostedSettlementLine[];
  /** Those an undo may take back: not a card refund's record. */
  undoableLines: PostedSettlementLine[];
}

async function readPaymentHandBacks(db: Reader, paymentId: string, bookingId: string): Promise<PaymentHandBacks> {
  const tasks = await refundNoteHandBackTasks(db, paymentId);
  const bankRefundLines = liveLines(await findPostedSettlementLines(db, bookingId, { kind: "BANK_REFUND" }));
  const handBackLines = bankRefundLines.filter((line) => line.anchorKind === "REVIEW_TASK" && tasks.has(line.anchorId));
  const undoableLines = handBackLines.filter((line) => tasks.get(line.anchorId)?.cardRecord === false);
  return { bankRefundLines, handBackLines, undoableLines };
}

/** A line's refund, positive cents (a hand-back line is a credit to the member). */
function lineCents(line: PostedSettlementLine): number {
  return -line.sign * line.unitCents * line.quantity;
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
    select: { id: true, source: true, refundedAmountCents: true, bookingId: true, booking: { select: { lodgeId: true } } },
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

  const followUp = await findFollowUpOfNote(db, paymentId, link.xeroObjectId);
  if (followUp) return result({ kind: "handled", by: "follow-up", followUpTaskId: followUp.id }, base);
  const marker = readBankRefundVoidMarker(link.metadata);
  if (marker) return result({ kind: "handled", by: marker.outcome, followUpTaskId: null }, base);

  // A create row whose note Xero voided can never mint again (#4091's asserts
  // refuse it), so it never holds a void back (#4162 review, money 4).
  const cancelledNoteIds = [...(await refundNoteIdSets(paymentId, db)).cancelled];
  const blockingOperationId = await findBlockingRefundCreditNoteOperationId(paymentId, db, { ignoreXeroObjectIds: cancelledNoteIds });
  if (blockingOperationId) return result({ kind: "deferred", blockingOperationId }, base);

  const recorded = await recordedRefundNoteAmountCents(paymentId, link, db);
  const amountCents = recorded !== null && Number.isSafeInteger(recorded) && recorded > 0 ? recorded : null;
  if (amountCents === null) return result({ kind: "unmatched", reason: "amount-unknown", amountCents: null }, base);

  const { bankRefundLines, handBackLines, undoableLines } = await readPaymentHandBacks(db, paymentId, payment.bookingId);
  const handBackCents = handBackLines.reduce((sum, line) => sum + lineCents(line), 0);

  // The spare check: Xero still records every bank hand-back and card refund.
  // A note resolved by hand whose own note Xero voided covers nothing (review, money 1).
  const resolved = await readResolvedRefundCreditNoteCoverage(
    paymentId,
    db,
    cancelledNoteIds.length > 0 ? { OR: [{ xeroObjectId: null }, { xeroObjectId: { notIn: cancelledNoteIds } }] } : undefined,
  );
  if (resolved.unreadableOperationIds.length > 0) return result({ kind: "unmatched", reason: "coverage-unknown", amountCents }, base);
  const coverageCents = await sumRefundCreditNoteCoverageCents(paymentId, resolved, db);
  const requiredCents = handBackCents + (await cardRefundCashCents(db, payment));
  if (handBackCents > 0 && coverageCents >= requiredCents) {
    return result({ kind: "spare", amountCents, coverageCents, requiredCents }, base);
  }

  const taskId = await noteHandBackTaskId(db, paymentId, link);
  // A card refund's record (a "Paid another way" close, a shortfall) is the
  // card refund pipeline's: its note is re-raised there, never undone here.
  const cardRecordLineIds = new Set(handBackLines.filter((line) => !undoableLines.includes(line)).map((line) => line.id));
  if (taskId !== null && handBackLines.some((line) => line.anchorId === taskId && cardRecordLineIds.has(line.id))) {
    return result({ kind: "unmatched", reason: "paid-another-way", amountCents }, base);
  }
  const sameAmount = (line: PostedSettlementLine) => lineCents(line) === amountCents;
  const candidates = undoableLines.filter((line) => sameAmount(line) && (taskId === null || line.anchorId === taskId));
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

/** The follow-up raised for a voided note, if any. */
async function findFollowUpOfNote(db: Reader, paymentId: string, creditNoteId: string) {
  return db.manualRefundTask.findUnique({
    where: { occurrenceKey: bankRefundVoidFollowUpOccurrenceKey(paymentId, creditNoteId) },
    select: { id: true },
  });
}

/** The live bank hand-backs a person may pick for an unmatched note on this payment (never a card refund's record). */
export async function readPickableHandBackLines(db: Reader, paymentId: string, bookingId: string): Promise<PickableHandBackLine[]> {
  const { undoableLines } = await readPaymentHandBacks(db, paymentId, bookingId);
  return undoableLines.map((line) => ({ lineId: line.id, taskId: line.anchorId, amountCents: lineCents(line) }));
}

/** Why a person's pick is refused, in the words the panel shows. */
export type PickRefusal = "not-unmatched" | "line-not-pickable" | "detail-short";

/**
 * #4162 (owner decision 18 Oct 2026, comment 6247741127): the undo a person's
 * pick asks for, re-read under the caller's locks - the note still unmatched,
 * the line a live hand-back line of THIS payment that an undo may take back,
 * and the payment's detail still holding its refund. The undo takes back the
 * picked line's refund.
 */
export async function resolvePickedUndo(
  db: Reader,
  note: ClassifiedVoidedNote,
  lineId: string,
): Promise<{ undo: BankRefundVoidUndo } | { refusal: PickRefusal }> {
  if (note.classification.kind !== "unmatched" || note.classification.reason === "paid-another-way" || !note.bookingId) {
    return { refusal: "not-unmatched" };
  }
  const { undoableLines } = await readPaymentHandBacks(db, note.paymentId, note.bookingId);
  const line = undoableLines.find((candidate) => candidate.id === lineId);
  if (!line) return { refusal: "line-not-pickable" };
  const amountCents = lineCents(line);
  if ((await unwindableHandBackCents(db, note.paymentId)) < amountCents) return { refusal: "detail-short" };
  return { undo: { amountCents, taskId: line.anchorId, line } };
}

/**
 * #4162 review (security 12): whether the payment holds a voided refund note
 * the follow-up has not handled yet - the inbound floor then logs its
 * divergence at info instead of alerting, because the follow-up resolves it.
 */
export async function hasVoidAwaitingFollowUp(db: Reader, paymentId: string): Promise<boolean> {
  const links =
    (await db.xeroObjectLink.findMany({
      where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" },
      select: { xeroObjectId: true, metadata: true },
    })) ?? [];
  for (const link of links) {
    if (!isRefundCreditNoteLinkCancelledInXero(link.metadata) || readBankRefundVoidMarker(link.metadata)) continue;
    if (!(await findFollowUpOfNote(db, paymentId, link.xeroObjectId))) return true;
  }
  return false;
}

/** A void deferred this long is listed for a person, so a stuck create never hides it (review, money 4). */
export const BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS = 7;

/** One voided note a person answers on Stuck States. */
export interface BankRefundVoidForAPerson {
  linkId: string;
  paymentId: string;
  bookingId: string;
  creditNoteNumber: string | null;
  creditNoteId: string;
  /** The voided note's recorded amount, or null when it cannot be read. */
  amountCents: number | null;
  /** When the app found the note voided (the link's last write), as an ISO instant - not Xero's own void time. */
  foundVoidedAt: string;
  /** Why it is here: unmatched (a person picks), or deferred too long (shown, nothing to pick yet). */
  reason: BankRefundVoidUnmatchedReason | "deferred";
  /** For an unmatched note, the payment's live bank refunds it may have recorded. Empty otherwise. */
  pickableLines: PickableHandBackLine[];
}

/**
 * Every voided bank-transfer refund note a person must look at, oldest first:
 * the `unmatched` ones (with the refunds a person may pick), and those
 * deferred for more than `BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS`. Read with the
 * pooled client, as advice: a pick re-classifies under the writer's locks.
 */
export async function listBankRefundVoidsForAPerson(db: Reader, now: Date = new Date()): Promise<BankRefundVoidForAPerson[]> {
  const items: BankRefundVoidForAPerson[] = [];
  const deferredBefore = now.getTime() - BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS * 24 * 60 * 60 * 1000;
  for (const linkId of await readVoidedBankRefundNoteLinkIds(db)) {
    const note = await classifyVoidedBankRefundNote(db, linkId);
    if (!note?.bookingId) continue;
    const c = note.classification;
    const unmatched = c.kind === "unmatched";
    if (!unmatched && !(c.kind === "deferred" && note.link.updatedAt.getTime() < deferredBefore)) continue;
    items.push({
      linkId,
      paymentId: note.paymentId,
      bookingId: note.bookingId,
      creditNoteNumber: note.link.xeroObjectNumber ?? null,
      creditNoteId: note.link.xeroObjectId,
      amountCents: c.kind === "unmatched" ? c.amountCents : null,
      foundVoidedAt: note.link.updatedAt.toISOString(),
      reason: c.kind === "unmatched" ? c.reason : "deferred",
      pickableLines: c.kind === "unmatched" && c.reason !== "paid-another-way" ? await readPickableHandBackLines(db, note.paymentId, note.bookingId) : [],
    });
  }
  return items;
}
