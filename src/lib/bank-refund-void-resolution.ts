import "server-only";

import { Prisma, type PaymentStatus } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  readBankRefundVoidPaymentId,
  readBankRefundVoidUnderLock,
  readVoidedNoteCreateRow,
  type BankRefundVoidUnderLock,
} from "@/lib/bank-refund-void-report";
import {
  BANK_REFUND_VOID_CONFIRM_BASES,
  CONFIRM_BASIS_LABEL,
  RE_RECORD_REFUSAL_MESSAGES,
  type BankRefundVoidConfirmBasis,
} from "@/lib/bank-refund-void-copy";
import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { handBackKey } from "@/lib/booking-ledger-posting-keys";
import { settlementLineReversal, type PostedSettlementLine } from "@/lib/booking-ledger-settlement-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import logger from "@/lib/logger";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import {
  lockPaymentForRefundedTotal,
  RefundAllocationRacedError,
  RefundUnwindExceedsAllocatedError,
  unwindLocalRefundAllocation,
} from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { getNextRefundedPaymentStatus } from "@/lib/xero-inbound/amounts";
import { asRecord, readString } from "@/lib/xero-json";
import { enqueueXeroRefundCreditNoteOperation, kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";

/**
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): THE
 * TREASURER'S TWO ANSWERS TO A VOIDED BANK-TRANSFER REFUND NOTE.
 *
 * On a bank transfer Xero is the payment rail (`INV-ADDPAY-021`), so when Xero
 * voids a refund credit note the inbound sync recounts the payment's refunded
 * total from the live notes and the refund reads as undone (`INV-ADDPAY-041`).
 * It does not touch the detail behind that total - the hand-back's allocation
 * on `PaymentTransaction` and its `BANK_REFUND` booking-ledger line both stand
 * (#4162 blueprint, finding 2, proven by `bank-refund-void-resolution.realdb.test.ts`).
 * Nothing re-raises the note automatically. The treasurer answers each voided
 * note V on the Stuck States finance panel (`bank-refund-void-report.ts`):
 *
 * - RECORD AGAIN (`reRecordBankTransferRefund`). The money went out once and
 *   the accounts are being redone, so: no booking event and no member email
 *   (Q3). The amount is V's recorded amount, shown read-only and confirmed by
 *   the request (`expectedAmountCents`, a 409 when it moved; refused when it
 *   cannot be read, Q1). In one transaction: the `RE_RECORDED` resolution (the
 *   unique pair is the claim), the refunded total put back by the part of V the
 *   recount took out of it (compare-and-set; the detail already holds V, so no
 *   allocation and no second ledger line), and ONE refund-note outbox row keyed
 *   on the resolution (`re-record:<id>`), sized by its record, copying V's
 *   method, wording and credited invoice (`INV-PAY-101`). Refused while a
 *   refund-note create on the payment could still mint, and when V's create was
 *   resolved by hand in Xero (`INV-INT-025`).
 * - CONFIRM (`confirmBankTransferRefundCancelled`), with the reason the
 *   treasurer gives. "The refund was cancelled" (Q2): the member was never
 *   paid, so the detail follows the total - V's amount comes back out of the
 *   transactions (`unwindLocalRefundAllocation`) and V's `BANK_REFUND` line is
 *   reversed (`settlementLineReversal`), and the refunded total is never left
 *   above that detail. "Replaced by hand in Xero" (Q4): the money did go back
 *   and a note made by hand in Xero records it, so nothing moves - the item
 *   leaves the list with the reason. Both write `CONFIRMED_CANCELLED`; no Xero
 *   call and no member email.
 *
 * LOCKS (`INV-LOCK-001`, `INV-LOCK-002`): both move a payment's refunded total
 * (or its detail) and every edit, acceptance, paid cancel and refund appeal
 * sizes a refund from those, so each takes global `lock(1)` first, then the
 * Payment row (`lockPaymentForRefundedTotal`) BEFORE it reads the payment,
 * then re-reads V, its resolution and the totals. The order every holder of
 * both already takes; no holder of the Payment row takes `lock(1)` after it.
 * The inbound void's recount takes neither: its compare-and-set on the row as
 * it read it loses to a write here and recounts. #4161's nightly heal takes the
 * link and the Payment row `NOWAIT` and defers. No provider call runs under
 * them: the note is an outbox row, kicked after the commit.
 */

/** A refusal with the status the route answers. Thrown before or inside the transaction, so nothing commits. */
export class BankRefundVoidResolutionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "BankRefundVoidResolutionError";
  }
}


interface CommonInput {
  /** The voided note's link id (`BankRefundVoidItem.linkId`). */
  linkId: string;
  /** The voided note's amount the treasurer saw. A different figure now is a 409. */
  expectedAmountCents: number;
  /** The treasurer's reason. Required. */
  note: string | null | undefined;
  actingMemberId: string;
}

function validateCommon(input: CommonInput): string {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) {
    throw new BankRefundVoidResolutionError("Say why - a note is required.", 400);
  }
  if (!Number.isSafeInteger(input.expectedAmountCents) || input.expectedAmountCents <= 0) {
    throw new BankRefundVoidResolutionError("Say what amount you saw, in whole cents, more than nothing.", 400);
  }
  return note;
}

/**
 * The shared re-read under both locks: V as the list would show it, still
 * unanswered, at the amount the treasurer saw. Refusals are 404 (nothing to
 * answer) or 409 (it moved, or it was answered).
 */
async function readUnansweredVoidUnderLocks(
  tx: Prisma.TransactionClient,
  input: CommonInput,
  now: Date,
): Promise<BankRefundVoidUnderLock & { amountCents: number }> {
  const paymentId = await readBankRefundVoidPaymentId(tx, input.linkId);
  if (!paymentId) throw new BankRefundVoidResolutionError("Voided refund note not found.", 404);
  // `lock(1)` is held; the Payment row before anything about it is read.
  await lockPaymentForRefundedTotal(tx, paymentId);
  const voided = await readBankRefundVoidUnderLock(tx, input.linkId, now);
  if (!voided || voided.paymentId !== paymentId) {
    throw new BankRefundVoidResolutionError(
      "This is not a voided bank-transfer refund note waiting for an answer. The list has been refreshed.",
      404,
    );
  }
  if (voided.resolution) {
    throw new BankRefundVoidResolutionError("This voided refund note has already been answered.", 409);
  }
  if (voided.amountCents === null) {
    throw new BankRefundVoidResolutionError(RE_RECORD_REFUSAL_MESSAGES["amount-unknown"], 409);
  }
  if (voided.amountCents !== input.expectedAmountCents) {
    throw new BankRefundVoidResolutionError(
      "The voided note's amount changed since you opened it. The list has been refreshed: check it and try again.",
      409,
    );
  }
  return { ...voided, amountCents: voided.amountCents };
}

/** The payment's figures both answers read under the locks: its refunded total and what its transactions record. */
async function readPaymentFigures(tx: Prisma.TransactionClient, paymentId: string) {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, bookingId: true, amountCents: true, refundedAmountCents: true, status: true },
  });
  if (!payment) throw new BankRefundVoidResolutionError("Voided refund note not found.", 404);
  const allocated = await tx.paymentTransaction.aggregate({
    where: { paymentId },
    _sum: { refundedAmountCents: true },
  });
  const booking = await tx.booking.findUnique({
    where: { id: payment.bookingId },
    select: { id: true, lodgeId: true, memberId: true },
  });
  if (!booking) throw new BankRefundVoidResolutionError("Voided refund note not found.", 404);
  return { payment, booking, allocatedCents: Math.max(0, allocated._sum.refundedAmountCents ?? 0) };
}

/**
 * Write the payment's refunded total, compare-and-set on the row as read (the
 * Payment row lock is held, so this is belt and braces), with its refund
 * status re-derived the way the inbound recount derives it.
 */
async function writeRefundedTotal(
  tx: Prisma.TransactionClient,
  payment: { id: string; amountCents: number; refundedAmountCents: number; status: PaymentStatus },
  nextRefundedCents: number,
): Promise<void> {
  if (nextRefundedCents === payment.refundedAmountCents) return;
  const nextStatus = getNextRefundedPaymentStatus(payment.status, payment.amountCents, nextRefundedCents);
  const written = await tx.payment.updateMany({
    where: { id: payment.id, refundedAmountCents: payment.refundedAmountCents, status: payment.status },
    data: { refundedAmountCents: nextRefundedCents, ...(nextStatus ? { status: nextStatus } : {}) },
  });
  if (written.count !== 1) {
    throw new BankRefundVoidResolutionError(
      "This payment's refunds changed while you were answering - refresh and try again.",
      409,
    );
  }
}

/** Insert the resolution: the unique pair is the claim, so a second answer is a 409 and nothing else commits. */
async function insertResolution(
  tx: Prisma.TransactionClient,
  data: Prisma.BankRefundVoidResolutionUncheckedCreateInput,
): Promise<{ id: string }> {
  try {
    return await tx.bankRefundVoidResolution.create({ data, select: { id: true } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new BankRefundVoidResolutionError("This voided refund note has already been answered.", 409);
    }
    throw error;
  }
}

export type ReRecordBankTransferRefundInput = CommonInput;

export interface ReRecordBankTransferRefundResult {
  resolutionId: string;
  paymentId: string;
  bookingId: string;
  amountCents: number;
  /** How much the refunded total was put back by: V's amount when the void's recount took it out, else 0. */
  restoredCents: number;
  noteOperationId: string;
}

/** V's own create row's method, wording and credited invoice, which its replacement copies (`INV-PAY-101`). */
async function voidedNoteDocument(tx: Prisma.TransactionClient, paymentId: string, creditNoteId: string) {
  const create = await readVoidedNoteCreateRow(tx, paymentId, creditNoteId);
  const recorded = create ? parsePaymentCreditNoteRetryInput(create) : null;
  const creditsInvoiceId =
    recorded?.creditsInvoiceId ?? readString(asRecord(asRecord(create?.requestPayload)?.allocation)?.invoiceId) ?? undefined;
  const method =
    recorded?.refundMethod === "card"
      ? { refundMethod: "card" as const }
      : {
          refundMethod: "internet-banking" as const,
          ...(recorded?.noteWording ? { noteWording: recorded.noteWording } : {}),
        };
  return { ...method, ...(creditsInvoiceId ? { creditsInvoiceId } : {}) };
}

/** Record a voided bank-transfer refund again. See the module comment. */
export async function reRecordBankTransferRefund(
  input: ReRecordBankTransferRefundInput,
): Promise<ReRecordBankTransferRefundResult> {
  const note = validateCommon(input);
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const voided = await readUnansweredVoidUnderLocks(tx, input, now);
    if (voided.reRecordRefusal) {
      throw new BankRefundVoidResolutionError(RE_RECORD_REFUSAL_MESSAGES[voided.reRecordRefusal], 409);
    }
    const { payment, booking, allocatedCents } = await readPaymentFigures(tx, voided.paymentId);
    const amountCents = voided.amountCents;
    // The detail still holds V (finding 2); the total holds it unless the
    // void's recount took it out. Put back exactly what the recount took, and
    // nothing when #4161's heal left the total where it was.
    if (allocatedCents < amountCents) {
      throw new BankRefundVoidResolutionError(
        "This payment's records no longer hold this refund, so it cannot be recorded again here. Ask a developer to reconcile it.",
        409,
      );
    }
    const restoredCents = Math.min(amountCents, Math.max(0, allocatedCents - payment.refundedAmountCents));
    if (restoredCents !== 0 && restoredCents !== amountCents) {
      throw new BankRefundVoidResolutionError(
        "This payment's refunded total does not match its refund records, so it cannot be recorded again here. Ask a developer to reconcile it.",
        409,
      );
    }
    if (payment.refundedAmountCents + restoredCents > payment.amountCents) {
      throw new BankRefundVoidResolutionError(
        "Recording this refund again would refund more than the payment holds. Ask a developer to reconcile it.",
        409,
      );
    }

    const resolution = await insertResolution(tx, {
      paymentId: payment.id,
      voidedCreditNoteId: voided.link.xeroObjectId,
      outcome: "RE_RECORDED",
      amountCents,
      note,
      resolvedByMemberId: input.actingMemberId,
      resolvedAt: now,
    });
    await writeRefundedTotal(tx, payment, payment.refundedAmountCents + restoredCents);

    // One fresh note, keyed on this record and sized by it, on this transaction.
    const document = await voidedNoteDocument(tx, payment.id, voided.link.xeroObjectId);
    const queued = await enqueueXeroRefundCreditNoteOperation(payment.id, amountCents, {
      ...document,
      createdByMemberId: input.actingMemberId,
      reRecordId: resolution.id,
      store: tx,
    });
    if (!queued.queueOperationId) {
      logger.warn({ paymentId: payment.id, resolutionId: resolution.id, message: queued.message }, "Record-again queued no refund note");
      throw new BankRefundVoidResolutionError(`No refund credit note could be queued: ${queued.message}`, 409);
    }
    await tx.bankRefundVoidResolution.update({
      where: { id: resolution.id },
      data: { noteOperationId: queued.queueOperationId },
    });

    await createAuditLog(
      {
        action: "booking-payment.bank-refund.re-recorded",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: booking.id,
        entityType: "BankRefundVoidResolution",
        entityId: resolution.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Bank-transfer refund on booking ${formatBookingReference(booking.id)} recorded again after Xero voided its credit note; one fresh refund credit note queued`,
        details: note,
        metadata: {
          paymentId: payment.id,
          voidedCreditNoteId: voided.link.xeroObjectId,
          amountCents,
          restoredCents,
          noteOperationId: queued.queueOperationId,
        },
      },
      tx,
    );

    return {
      resolutionId: resolution.id,
      paymentId: payment.id,
      bookingId: booking.id,
      amountCents,
      restoredCents,
      noteOperationId: queued.queueOperationId,
    };
  });

  // The note's row committed with the record-again: only the kick is left.
  await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((error: unknown) =>
    logger.error({ err: error, resolutionId: result.resolutionId }, "Failed to kick the Xero outbox after a record-again"),
  );
  return result;
}

export interface ConfirmBankTransferRefundCancelledInput extends CommonInput {
  /** Why it is being cleared: the refund was cancelled, or its note was replaced by hand in Xero. */
  basis: BankRefundVoidConfirmBasis;
}

export interface ConfirmBankTransferRefundCancelledResult {
  resolutionId: string;
  paymentId: string;
  bookingId: string;
  amountCents: number;
  basis: BankRefundVoidConfirmBasis;
  /** What came back out of the payment's transactions: V's amount for a cancellation, 0 for a note replaced in Xero. */
  unwoundCents: number;
  /** The `BANK_REFUND` line reversed, or null when there was none to reverse. */
  reversedLedgerLineId: string | null;
}

/** The voided note's `BANK_REFUND` line: one live line for exactly its amount, or none. */
type LedgerLineMatch = { kind: "line"; line: PostedSettlementLine } | { kind: "none" } | { kind: "ambiguous" };

/**
 * Which live `BANK_REFUND` line records V's refund. A note raised for a task
 * (a review's or a close's: `reviewTaskId`, `paidAnotherWayTaskId` on its
 * create row) names it by key (`handBackKey`); the payment's one canonical
 * note does not, so it is the one live hand-back line of V's amount on one of
 * the payment's completed tasks. More than one candidate, or one for another
 * amount, is ambiguous and refused; none is a refund the ledger never posted.
 */
async function findVoidedRefundLedgerLine(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; paymentId: string; creditNoteId: string; amountCents: number },
): Promise<LedgerLineMatch> {
  const lines = liveLines(
    (await tx.bookingLedgerLine.findMany({
      where: { bookingId: input.bookingId, kind: "BANK_REFUND" },
      select: {
        id: true,
        postingKey: true,
        reversesLineId: true,
        kind: true,
        sign: true,
        quantity: true,
        unitCents: true,
        amountCents: true,
        anchorKind: true,
        anchorId: true,
        settlementMethod: true,
        narration: true,
      },
    })) ?? [],
  );
  const create = await readVoidedNoteCreateRow(tx, input.paymentId, input.creditNoteId);
  const payload = asRecord(create?.requestPayload);
  const taskId = readString(payload?.reviewTaskId) ?? readString(payload?.paidAnotherWayTaskId);
  const toPosted = (line: (typeof lines)[number]): PostedSettlementLine => ({
    ...line,
    kind: line.kind as PostedSettlementLine["kind"],
    sign: line.sign === 1 ? 1 : -1,
    anchorKind: line.anchorKind as PostedSettlementLine["anchorKind"],
    settlementMethod: line.settlementMethod as PostedSettlementLine["settlementMethod"],
  });
  if (taskId) {
    const own = lines.find((line) => line.postingKey === handBackKey(taskId));
    if (!own) return { kind: "none" };
    return own.amountCents === -input.amountCents ? { kind: "line", line: toPosted(own) } : { kind: "ambiguous" };
  }
  const taskIds = new Set(
    (
      (await tx.manualRefundTask.findMany({
        where: { paymentId: input.paymentId, status: "COMPLETED" },
        select: { id: true },
      })) ?? []
    ).map((task) => task.id),
  );
  const sameAmount = lines.filter((line) => line.amountCents === -input.amountCents);
  const onTasks = sameAmount.filter((line) => line.anchorKind === "REVIEW_TASK" && taskIds.has(line.anchorId));
  if (onTasks.length === 1 && sameAmount.length === 1) return { kind: "line", line: toPosted(onTasks[0]!) };
  return sameAmount.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
}

/** Confirm a voided bank-transfer refund note cancelled, or replaced by hand in Xero. See the module comment. */
export async function confirmBankTransferRefundCancelled(
  input: ConfirmBankTransferRefundCancelledInput,
): Promise<ConfirmBankTransferRefundCancelledResult> {
  const reason = validateCommon(input);
  if (!(BANK_REFUND_VOID_CONFIRM_BASES as readonly string[]).includes(input.basis)) {
    throw new BankRefundVoidResolutionError("Say whether the refund was cancelled or its note replaced in Xero.", 400);
  }
  const note = `${CONFIRM_BASIS_LABEL[input.basis]}: ${reason}`;
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const voided = await readUnansweredVoidUnderLocks(tx, input, now);
    const { payment, booking, allocatedCents } = await readPaymentFigures(tx, voided.paymentId);
    const amountCents = voided.amountCents;

    let unwoundCents = 0;
    let reversedLedgerLineId: string | null = null;
    if (input.basis === "cancelled") {
      // Q2: the detail follows the total. V's amount comes out of the
      // transactions and its line is reversed; the total never stays above
      // what the transactions then hold (it already does not, once the void's
      // recount ran; #4161's heal can leave it counting V).
      if (allocatedCents < amountCents) {
        throw new BankRefundVoidResolutionError(
          "This payment's records no longer hold this refund, so there is nothing to take back. Ask a developer to reconcile it.",
          409,
        );
      }
      const match = await findVoidedRefundLedgerLine(tx, {
        bookingId: booking.id,
        paymentId: payment.id,
        creditNoteId: voided.link.xeroObjectId,
        amountCents,
      });
      if (match.kind === "ambiguous") {
        throw new BankRefundVoidResolutionError(
          "The booking ledger has no single line for this refund, so it cannot be taken back here. Ask a developer to reconcile it.",
          409,
        );
      }
      try {
        await unwindLocalRefundAllocation({ paymentId: payment.id, amountCents, store: tx });
      } catch (error) {
        if (error instanceof RefundUnwindExceedsAllocatedError || error instanceof RefundAllocationRacedError) {
          throw new BankRefundVoidResolutionError(
            "This payment's refunds changed while you were answering - refresh and try again.",
            409,
          );
        }
        throw error;
      }
      unwoundCents = amountCents;
      await writeRefundedTotal(tx, payment, Math.min(payment.refundedAmountCents, allocatedCents - amountCents));
      if (match.kind === "line") {
        // Built in pure code first: a planning fault is refused before any
        // statement reaches the database (`buildBookingLedgerRows`).
        const written = await writeBookingLedgerRows(
          tx,
          buildBookingLedgerRows([
            settlementLineReversal({ bookingId: booking.id, lodgeId: booking.lodgeId }, match.line, input.actingMemberId),
          ]),
        );
        if (written !== 1) {
          throw new BankRefundVoidResolutionError(
            "This refund's ledger line was already taken back. Refresh and check it.",
            409,
          );
        }
        reversedLedgerLineId = match.line.id;
      }
    }

    const resolution = await insertResolution(tx, {
      paymentId: payment.id,
      voidedCreditNoteId: voided.link.xeroObjectId,
      outcome: "CONFIRMED_CANCELLED",
      amountCents,
      note,
      resolvedByMemberId: input.actingMemberId,
      resolvedAt: now,
    });

    await createAuditLog(
      {
        action: "booking-payment.bank-refund.void-confirmed",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: booking.id,
        entityType: "BankRefundVoidResolution",
        entityId: resolution.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary:
          input.basis === "cancelled"
            ? `Bank-transfer refund on booking ${formatBookingReference(booking.id)} confirmed cancelled after Xero voided its credit note; taken back out of the payment's records`
            : `Bank-transfer refund on booking ${formatBookingReference(booking.id)} confirmed replaced by hand in Xero after its credit note was voided`,
        details: reason,
        metadata: {
          paymentId: payment.id,
          voidedCreditNoteId: voided.link.xeroObjectId,
          basis: input.basis,
          amountCents,
          unwoundCents,
          reversedLedgerLineId,
        },
      },
      tx,
    );

    return {
      resolutionId: resolution.id,
      paymentId: payment.id,
      bookingId: booking.id,
      amountCents,
      basis: input.basis,
      unwoundCents,
      reversedLedgerLineId,
    };
  });
}
