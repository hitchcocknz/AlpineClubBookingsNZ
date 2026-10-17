import { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  bankRefundVoidFollowUpReviewContext,
} from "@/lib/bank-refund-void-follow-up-copy";
import {
  BANK_REFUND_VOID_MARKER_KEY,
  classifyVoidedBankRefundNote,
  readVoidedBankRefundNoteLinkIds,
  type BankRefundVoidClassification,
  type BankRefundVoidMarker,
  type ClassifiedVoidedNote,
} from "@/lib/bank-refund-void-scan";
import { settlementLineReversal } from "@/lib/booking-ledger-settlement-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { bankRefundVoidFollowUpOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import {
  lockPaymentForRefundedTotal,
  reconcilePaymentAggregates,
  unwindLocalRefundAllocation,
} from "@/lib/payment-transactions";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { isXeroBankRefundVoidWritesEnabled } from "@/lib/xero-feature-flags";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): UNDO, THEN ASK ONCE.
 *
 * The treasurer's hand-back is the record that a bank refund was paid; its
 * Xero credit note mirrors it. When Xero voids that note, the refund is no
 * longer recorded, so each night - after #4161's heal has turned the voided
 * mirror off - this job carries the void through every app record and puts the
 * money back on the treasurer's refund list as owed, with one question. Each
 * voided bank-transfer refund note is handled EXACTLY ONCE
 * (`classifyVoidedBankRefundNote` says how):
 *
 * - a SPARE note (live notes, plus notes resolved by hand in Xero, still cover
 *   every bank hand-back) moves nothing; a marker on its link records that it
 *   was handled, so it is not examined forever;
 * - a note that recorded ONE hand-back's refund is undone in one transaction:
 *   the follow-up hand-back ("Refund to re-confirm", key
 *   `bank-refund-void:<paymentId>:<creditNoteId>`) is inserted first - the
 *   unique key is the claim, so a lost claim moves nothing - then the amount
 *   comes out of the allocation (`unwindLocalRefundAllocation`), the
 *   hand-back's `BANK_REFUND` line is reversed (`settlementLineReversal`) and
 *   the refunded total is recomputed from the detail
 *   (`reconcilePaymentAggregates`). No email, no booking event, no provider
 *   call: nothing is raised in Xero without a person;
 * - an unmatched or ambiguous note goes to a person on Stuck States, and moves
 *   nothing here.
 *
 * REPORT-ONLY BY DEFAULT: until the operator sets
 * `XERO_ENABLE_BANK_REFUND_VOID_WRITES=true` the job classifies every note,
 * logs what it would do, and writes nothing.
 *
 * LOCKS (`INV-LOCK-001`, `INV-LOCK-002`): the undo moves settlement money that
 * every edit, acceptance, paid cancel and refund appeal reads to size a
 * refund, so each note's transaction takes global `lock(1)` first, then the
 * Payment row (`lockPaymentForRefundedTotal`) BEFORE anything about the
 * payment is read, then re-classifies under both. The spare marker's link row
 * is taken last and `NOWAIT`: the inbound sync's link write and #4161's heal
 * take the link before the Payment row, so a busy link defers the note to the
 * next run rather than waiting with the Payment row held. One note per
 * transaction, so a slow note never holds another payment's locks.
 */

export type BankRefundVoidJobOutcome =
  | "undone"
  | "spare"
  | "handled"
  | "deferred"
  | "unmatched"
  | "awaiting-heal"
  | "not-in-scope"
  | "failed";

export interface BankRefundVoidJobItem {
  linkId: string;
  paymentId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  outcome: BankRefundVoidJobOutcome;
  /** What the job would do (report-only) or did, in a line. */
  detail: string;
  amountCents: number | null;
  followUpTaskId?: string | null;
}

export interface BankRefundVoidJobResult {
  mode: "report-only" | "writes";
  scanned: number;
  counts: Record<BankRefundVoidJobOutcome, number>;
  /** Every note that is not already handled, in scan order. */
  items: BankRefundVoidJobItem[];
}

const OUTCOMES: readonly BankRefundVoidJobOutcome[] = [
  "undone",
  "spare",
  "handled",
  "deferred",
  "unmatched",
  "awaiting-heal",
  "not-in-scope",
  "failed",
];

/** The outcome a classification leads to, before anything is written. */
function plannedOutcome(classification: BankRefundVoidClassification): BankRefundVoidJobOutcome {
  return classification.kind === "undo" ? "undone" : classification.kind;
}

function describe(classification: BankRefundVoidClassification, writes: boolean): string {
  switch (classification.kind) {
    case "undo":
      return `${writes ? "Undone" : "Would undo"}: the hand-back's refund taken out of the allocation, its ledger line reversed, the total recomputed, and one follow-up raised`;
    case "spare":
      return `Spare: live notes cover ${classification.coverageCents} of ${classification.requiredCents} cents; nothing moves`;
    case "deferred":
      return `Deferred: refund-note operation ${classification.blockingOperationId} could still mint`;
    case "unmatched":
      return `Unmatched (${classification.reason}): a person answers it on Stuck States`;
    case "awaiting-heal":
      return "Awaiting #4161's heal: the voided mirror is still active";
    case "handled":
      return `Already handled (${classification.by})`;
    default:
      return "Not a voided bank-transfer refund note";
  }
}

function itemOf(note: ClassifiedVoidedNote, outcome: BankRefundVoidJobOutcome, detail: string, extra?: Partial<BankRefundVoidJobItem>): BankRefundVoidJobItem {
  const c = note.classification;
  return {
    linkId: note.link.id,
    paymentId: note.paymentId,
    creditNoteId: note.link.xeroObjectId,
    creditNoteNumber: note.link.xeroObjectNumber ?? null,
    outcome,
    detail,
    amountCents: c.kind === "undo" || c.kind === "spare" ? c.amountCents : c.kind === "unmatched" ? c.amountCents : null,
    ...extra,
  };
}

/**
 * Write a handled marker onto a voided note's link, merged into its metadata.
 * The link row is taken `NOWAIT` after the caller's Payment row (see the
 * module comment), and re-read under it: a link that is no longer a voided
 * refund note, or already carries a marker, is left alone.
 */
export async function writeBankRefundVoidMarker(
  tx: Prisma.TransactionClient,
  linkId: string,
  marker: BankRefundVoidMarker,
): Promise<boolean> {
  await tx.$executeRaw`SELECT 1 FROM "XeroObjectLink" WHERE "id" = ${linkId} FOR UPDATE NOWAIT`;
  const link = await tx.xeroObjectLink.findUnique({ where: { id: linkId }, select: { metadata: true } });
  const metadata = asRecord(link?.metadata);
  if (!link || !metadata || metadata[BANK_REFUND_VOID_MARKER_KEY] !== undefined) return false;
  await tx.xeroObjectLink.update({
    where: { id: linkId },
    data: { metadata: { ...metadata, [BANK_REFUND_VOID_MARKER_KEY]: { ...marker } } as Prisma.InputJsonObject },
  });
  return true;
}

/** The follow-up's reason line, as the refund list and the old app version show it. */
function followUpReason(bookingId: string, creditNoteNumber: string | null): string {
  return `Refund to re-confirm: Xero credit note ${creditNoteNumber ?? "(no number)"} for booking ${formatBookingReference(bookingId)} was voided, so this bank refund is back on the list. Check whether the money went to the member (#4162).`.slice(
    0,
    MANUAL_REFUND_TASK_REASON_MAX,
  );
}

/**
 * Handle ONE voided note under the locks, writing. Exported for the realdb
 * suite and the job below; nothing else calls it.
 */
export async function followUpVoidedBankRefundNote(linkId: string, now: Date = new Date()): Promise<BankRefundVoidJobItem | null> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        // The link's payment is immutable: read unlocked, only to know which row to lock.
        const head = await tx.xeroObjectLink.findUnique({ where: { id: linkId }, select: { localModel: true, localId: true } });
        if (!head || head.localModel !== "Payment") return null;
        await lockPaymentForRefundedTotal(tx, head.localId);
        const note = await classifyVoidedBankRefundNote(tx, linkId);
        if (!note) return null;
        const c = note.classification;
        if (c.kind === "spare") {
          await writeBankRefundVoidMarker(tx, linkId, { outcome: "spare", at: now.toISOString() });
          return itemOf(note, "spare", describe(c, true));
        }
        if (c.kind !== "undo") return itemOf(note, plannedOutcome(c), describe(c, true));

        const bookingId = note.bookingId!;
        const lodgeId = note.lodgeId!;
        // THE CLAIM, before any money moves: the unique occurrence key. A lost
        // claim (another run raised it) inserts nothing and moves nothing.
        const occurrenceKey = bankRefundVoidFollowUpOccurrenceKey(note.paymentId, note.link.xeroObjectId);
        const claimed = await tx.manualRefundTask.createMany({
          data: [
            {
              bookingId,
              paymentId: note.paymentId,
              amountCents: c.amountCents,
              raisedAmountCents: c.amountCents,
              kind: "CANCELLED_BOOKING_HAND_BACK",
              occurrenceKey,
              reason: followUpReason(bookingId, note.link.xeroObjectNumber ?? null),
              reviewContext: bankRefundVoidFollowUpReviewContext({
                voidedCreditNoteId: note.link.xeroObjectId,
                voidedCreditNoteNumber: note.link.xeroObjectNumber ?? null,
                voidedAt: note.link.updatedAt.toISOString(),
                originalTaskId: c.taskId,
                reversedLineId: c.line.id,
              }),
            },
          ],
          skipDuplicates: true,
        });
        if (claimed.count !== 1) {
          return itemOf(note, "handled", "Already handled (follow-up raised by another run)");
        }
        await unwindLocalRefundAllocation({ paymentId: note.paymentId, amountCents: c.amountCents, store: tx });
        const written = await writeBookingLedgerRows(tx, buildBookingLedgerRows([settlementLineReversal({ bookingId, lodgeId }, c.line)]));
        if (written !== 1) {
          // A replay would have lost the claim above; a reversal already there
          // means the ledger moved under us. Roll the whole undo back.
          throw new Error(`Bank refund void follow-up: the hand-back line ${c.line.id} was already reversed`);
        }
        await reconcilePaymentAggregates({ paymentId: note.paymentId, store: tx });
        const task = await tx.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey }, select: { id: true } });
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { memberId: true },
        });
        await createAuditLog(
          {
            action: "booking-payment.bank-refund.void-undone",
            memberId: null,
            actorMemberId: null,
            subjectMemberId: bookingOwner(booking).memberId,
            targetId: bookingId,
            entityType: "ManualRefundTask",
            entityId: task.id,
            category: "payment",
            severity: "important",
            outcome: "success",
            summary: `Xero voided the refund credit note ${note.link.xeroObjectNumber ?? note.link.xeroObjectId} on booking ${formatBookingReference(bookingId)}; the bank refund was taken back out of the payment's records and put back on the refund list to re-confirm`,
            metadata: {
              paymentId: note.paymentId,
              voidedCreditNoteId: note.link.xeroObjectId,
              amountCents: c.amountCents,
              originalTaskId: c.taskId,
              reversedLineId: c.line.id,
            },
          },
          tx,
        );
        return itemOf(note, "undone", describe(c, true), { followUpTaskId: task.id });
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) {
      logger.warn({ linkId }, "Deferred a voided bank-transfer refund note to the next run: its link row was busy (#4162)");
      return {
        linkId,
        paymentId: "",
        creditNoteId: "",
        creditNoteNumber: null,
        outcome: "deferred",
        detail: "Deferred: the link row was busy",
        amountCents: null,
      };
    }
    throw error;
  }
}

/**
 * THE NIGHTLY JOB. Runs from the Xero cron runner after #4161's link cleanup.
 * `writes` defaults to the operator switch; report-only classifies with the
 * pooled client and writes nothing at all.
 */
export async function runBankRefundVoidFollowUp(options?: { writes?: boolean; now?: Date }): Promise<BankRefundVoidJobResult> {
  const writes = options?.writes ?? isXeroBankRefundVoidWritesEnabled();
  const now = options?.now ?? new Date();
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<BankRefundVoidJobOutcome, number>;
  const items: BankRefundVoidJobItem[] = [];
  const linkIds = await readVoidedBankRefundNoteLinkIds(prisma);
  for (const linkId of linkIds) {
    let item: BankRefundVoidJobItem | null;
    try {
      if (writes) {
        item = await followUpVoidedBankRefundNote(linkId, now);
      } else {
        const note = await classifyVoidedBankRefundNote(prisma as unknown as Prisma.TransactionClient, linkId);
        item = note ? itemOf(note, plannedOutcome(note.classification), describe(note.classification, false)) : null;
      }
    } catch (error) {
      logger.error({ err: error, linkId }, "Failed to follow up a voided bank-transfer refund note (#4162)");
      item = { linkId, paymentId: "", creditNoteId: "", creditNoteNumber: null, outcome: "failed", detail: error instanceof Error ? error.message : String(error), amountCents: null };
    }
    if (!item) continue;
    counts[item.outcome] += 1;
    if (item.outcome !== "handled" && item.outcome !== "not-in-scope") items.push(item);
  }
  const result: BankRefundVoidJobResult = { mode: writes ? "writes" : "report-only", scanned: linkIds.length, counts, items };
  logger.info({ mode: result.mode, scanned: result.scanned, counts }, "Voided bank-transfer refund notes followed up (#4162)");
  return result;
}

/** The cron task's failure line: any note that failed, else null. */
export function bankRefundVoidFollowUpFailureMessage(result: BankRefundVoidJobResult): string | null {
  return result.counts.failed > 0
    ? `${result.counts.failed} voided bank-transfer refund note(s) could not be followed up; see the logs (#4162)`
    : null;
}
