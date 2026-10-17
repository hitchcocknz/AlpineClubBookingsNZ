import type { ManualRefundTaskKind, Prisma } from "@prisma/client";
import { z } from "zod";

import {
  BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE,
  BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE,
  bankRefundVoidCompletionMessage,
  HAND_MADE_CREDIT_NOTE_NUMBER_MAX,
  readBankRefundVoidFollowUpContext,
  type BankRefundVoidAnswer,
} from "@/lib/bank-refund-void-follow-up-copy";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { isIncludedRefundCreditNoteStatus } from "@/lib/xero-refund-note-status";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): THE "YES, I ALREADY
 * RECORDED IT IN XERO MYSELF" ANSWER to a bank refund to re-confirm.
 *
 * The treasurer types the number of the credit note they made in Xero by hand.
 * Before anything is written, the app reads that note from Xero - OUTSIDE any
 * transaction, so no lock is held across the provider call - and checks it is
 * a sales credit note, live (not VOIDED or DELETED) and for exactly the
 * follow-up's amount, and that no record here tracks it already. A mismatch is
 * refused with a plain-English reason and nothing moves.
 *
 * On success the completion (`resolveManualRefundTask`, under its locks) puts
 * the money back on the payment as an ordinary hand-back completion does and
 * records the note as a tracked refund-note link for the follow-up
 * (`recordHandMadeRefundNoteLink`), stamped per refund so it stands beside the
 * payment's other notes, and naming the follow-up (`handBackTaskId`). A later
 * void of it in Xero is then caught like any other: the inbound sync marks the
 * link voided and the nightly follow-up undoes it again.
 */

/** A hand-made note as Xero reported it, checked. Carried into the completion's transaction. */
export interface VerifiedHandMadeRefundNote {
  creditNoteId: string;
  creditNoteNumber: string;
  amountCents: number;
  status: string;
  total: number;
}

/**
 * The answer as the completion route receives it: raise a fresh credit note,
 * or the number of the note the treasurer already made in Xero (checked
 * against Xero before anything is written, `prepareBankRefundVoidAnswer`).
 */
export const bankRefundVoidAnswerBodySchema = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("fresh-note") }).strict(),
  z.object({ answer: z.literal("recorded-in-xero"), creditNoteNumber: z.string().trim().min(1).max(HAND_MADE_CREDIT_NOTE_NUMBER_MAX) }).strict(),
]);

/** What the treasurer is told once the completion took the answer. */
export function bankRefundVoidAnswerMessage(answer: ResolvedBankRefundVoidAnswer): string {
  return bankRefundVoidCompletionMessage(answer.answer, answer.answer === "recorded-in-xero" ? answer.note.creditNoteNumber : null);
}

/** The completion's answer to a follow-up, once a hand-made note has been checked. */
export type ResolvedBankRefundVoidAnswer =
  | { answer: Extract<BankRefundVoidAnswer, "fresh-note"> }
  | { answer: Extract<BankRefundVoidAnswer, "recorded-in-xero">; note: VerifiedHandMadeRefundNote };

/** A credit-note number this answer will search Xero for: no quotes or backslashes in Xero's filter. */
function normaliseCreditNoteNumber(raw: string): string {
  const number = raw.trim();
  if (number.length === 0 || number.length > HAND_MADE_CREDIT_NOTE_NUMBER_MAX || /["\\]/.test(number)) {
    throw new ManualBookingPaymentError("Type the credit note's number as Xero shows it, for example CN-0123.", 400);
  }
  return number;
}

/**
 * Read the hand-made note from Xero and check it. No transaction is open; the
 * caller passes the result into the completion. Refuses with a 400/409 whose
 * message the treasurer reads.
 */
export async function verifyHandMadeRefundNote(input: {
  creditNoteNumber: string;
  expectedAmountCents: number;
  format: ClubFormat;
}): Promise<VerifiedHandMadeRefundNote> {
  const number = normaliseCreditNoteNumber(input.creditNoteNumber);
  let creditNotes: Array<{
    creditNoteID?: string;
    creditNoteNumber?: string;
    status?: unknown;
    type?: unknown;
    total?: number;
  }>;
  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getCreditNotes(tenantId, undefined, `CreditNoteNumber=="${number}"`),
      {
        operation: "getCreditNotes",
        resourceType: "CREDIT_NOTE",
        workflow: "verifyHandMadeRefundNote",
        context: `verifyHandMadeRefundNote(${number})`,
      },
    );
    creditNotes = (response.body.creditNotes ?? []) as typeof creditNotes;
  } catch {
    throw new ManualBookingPaymentError(
      "The app could not reach Xero to check that credit note. Check Xero is connected, then try again.",
      409,
    );
  }
  const matches = creditNotes.filter((note) => note.creditNoteID && note.creditNoteNumber?.trim() === number);
  if (matches.length === 0) {
    throw new ManualBookingPaymentError(`Xero has no credit note numbered ${number}. Check the number and try again.`, 409);
  }
  if (matches.length > 1) {
    throw new ManualBookingPaymentError(`Xero has more than one credit note numbered ${number}, so the app cannot tell which you mean.`, 409);
  }
  const note = matches[0]!;
  const status = String(note.status ?? "");
  if (!isIncludedRefundCreditNoteStatus(status) || status.trim() === "") {
    throw new ManualBookingPaymentError(`Credit note ${number} is ${status.trim().toLowerCase() || "not live"} in Xero, so it does not record this refund.`, 409);
  }
  if (String(note.type ?? "") !== "ACCRECCREDIT") {
    throw new ManualBookingPaymentError(`Credit note ${number} is not a sales credit note in Xero, so it does not record a refund to a member.`, 409);
  }
  const amountCents = providerAmountToCents(note.total);
  if (amountCents !== input.expectedAmountCents) {
    throw new ManualBookingPaymentError(
      `Credit note ${number} is for ${amountCents === null ? "an amount the app cannot read" : formatCents(amountCents, input.format)} in Xero, not ${formatCents(input.expectedAmountCents, input.format)}, so it does not record this refund.`,
      409,
    );
  }
  return { creditNoteId: note.creditNoteID!, creditNoteNumber: number, amountCents, status, total: note.total! };
}

/**
 * The route's half of the answer: an unlocked read of the task (only to know
 * its amount and that it is a follow-up), then the Xero check for the
 * "already in Xero" answer. The completion re-reads the task under its locks.
 */
export async function prepareBankRefundVoidAnswer(input: {
  taskId: string;
  answer: z.infer<typeof bankRefundVoidAnswerBodySchema>;
  format: ClubFormat;
}): Promise<ResolvedBankRefundVoidAnswer> {
  if (input.answer.answer === "fresh-note") return { answer: "fresh-note" };
  const task = await prisma.manualRefundTask.findUnique({
    where: { id: input.taskId },
    select: { kind: true, occurrenceKey: true, amountCents: true, reviewContext: true },
  });
  if (!task || !isBankRefundVoidFollowUpTask(task) || !readBankRefundVoidFollowUpContext(task.reviewContext) || task.amountCents === null) {
    throw new ManualBookingPaymentError(
      "This refund was not put back on the list by a voided credit note, so that answer does not apply. Refresh the page and try again.",
      400,
    );
  }
  const note = await verifyHandMadeRefundNote({
    creditNoteNumber: input.answer.creditNoteNumber,
    expectedAmountCents: task.amountCents,
    format: input.format,
  });
  return { answer: "recorded-in-xero", note };
}

/**
 * Inside the completion's transaction, after its allocation: record the
 * checked note as the follow-up's tracked refund note. Refused (rolling the
 * completion back) when any record here already tracks that Xero note.
 */
export async function recordHandMadeRefundNoteLink(
  tx: Prisma.TransactionClient,
  input: { paymentId: string; taskId: string; amountCents: number; note: VerifiedHandMadeRefundNote },
): Promise<void> {
  if (input.note.amountCents !== input.amountCents) {
    throw new ManualBookingPaymentError("This refund's amount changed while you were answering - refresh and try again.", 409);
  }
  const tracked = await tx.xeroObjectLink.findFirst({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: input.note.creditNoteId },
    select: { id: true },
  });
  if (tracked) {
    throw new ManualBookingPaymentError(
      `Credit note ${input.note.creditNoteNumber} is already recorded against another refund or booking here, so it cannot also record this one.`,
      409,
    );
  }
  await upsertXeroObjectLink(
    {
      localModel: "Payment",
      localId: input.paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: input.note.creditNoteId,
      xeroObjectNumber: input.note.creditNoteNumber,
      role: "REFUND_CREDIT_NOTE",
      active: true,
      metadata: {
        status: input.note.status,
        total: input.note.total,
        amountCents: input.note.amountCents,
        // A note per refund: it stands beside the payment's other notes and
        // is never its one canonical note (`isPerDeltaRefundNoteLink`).
        perDelta: true,
        handBackTaskId: input.taskId,
        recordedByHand: true,
      },
    },
    { store: tx },
  );
}

/**
 * The completion's half of a follow-up's answer, inside its transaction after
 * the allocation and the hand-back line - so the money goes back on the
 * payment exactly as an ordinary hand-back completion records it, and the
 * answer commits or rolls back with it. Called for every completion: a
 * follow-up with no answer, or an answer on any other task, is refused here
 * and the whole completion rolls back. The completion also writes no
 * `REFUNDED` booking event for a follow-up: the money moved once (Q3).
 *
 * - "fresh-note": ONE refund note queued on the outbox, keyed and sized on the
 *   follow-up itself (`paidAnotherWayTaskId`, as a card refund shortfall's
 *   is), dated today; nothing is copied from the voided note. None where the
 *   payment has no invoice to credit (a note against no invoice is a row that
 *   can never succeed). The outbox's 15-minute run sends it;
 * - "recorded-in-xero": the checked hand-made note becomes the follow-up's
 *   tracked refund-note link; nothing is queued.
 */
export async function recordBankRefundVoidAnswerInTransaction(input: {
  task: { id: string; kind: ManualRefundTaskKind | null; occurrenceKey: string | null; booking: { payment: { xeroInvoiceId: string | null } | null } };
  route: { kind: string; paymentId?: string | null; refundCents?: number } | null;
  answer: ResolvedBankRefundVoidAnswer | null;
  actingMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const followUp = isBankRefundVoidFollowUpTask(input.task);
  if (followUp && !input.answer) throw new ManualBookingPaymentError(BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE, 400);
  if (!followUp && input.answer) throw new ManualBookingPaymentError(BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE, 400);
  const { answer, route } = input;
  if (!answer || route?.kind !== "local-allocation" || !route.paymentId || !route.refundCents || route.refundCents <= 0) return;
  if (answer.answer === "recorded-in-xero") {
    await recordHandMadeRefundNoteLink(input.store, { paymentId: route.paymentId, taskId: input.task.id, amountCents: route.refundCents, note: answer.note });
    return;
  }
  if (!input.task.booking.payment?.xeroInvoiceId) return;
  const queued = await enqueueXeroRefundCreditNoteOperation(route.paymentId, route.refundCents, {
    createdByMemberId: input.actingMemberId,
    refundMethod: "internet-banking",
    paidAnotherWayTaskId: input.task.id,
    store: input.store,
  });
  if (!queued.queueOperationId) {
    logger.warn({ taskId: input.task.id, paymentId: route.paymentId, message: queued.message }, "A re-confirmed bank refund queued no fresh credit note (#4162)");
  }
}
