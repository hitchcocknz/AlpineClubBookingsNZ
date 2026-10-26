import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isResolvedInXero, XERO_OPERATION_REASON_MAX, XERO_OPERATION_REASON_MIN } from "@/lib/xero-operation-resolution";
import { isAppliedCreditLedgerOperation } from "@/lib/xero-applied-credit-operation-serialization";
import { clubFormatValues } from "@/lib/club-format-server";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { reconcileHandMadeNoteAfterRecording, type VerifiedHandMadeRefundNote } from "@/lib/bank-refund-void-answer";
import {
  claimResolveRecordingRefundNote,
  refundNoteResolveShape,
  verifyResolvedRefundNote,
  withdrawResolveRecordingRefundNote,
} from "@/lib/xero-resolve-refund-note";
import {
  alreadyResolvedWithNoteMessage,
  HAND_MADE_CREDIT_NOTE_NUMBER_MAX,
  RESOLVE_NOTE_NOT_ASKED_MESSAGE,
  RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE,
  RESOLVE_NOTE_SUPERSEDED_MESSAGE,
  RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE,
} from "@/lib/bank-refund-void-follow-up-copy";
import {
  findQueuedLiveCopy,
  findRetryOverlappingMark,
  findSupersedingRefundNoteRun,
  QUEUED_LIVE_COPY_REFUSAL,
  retryRunningRefusal,
  type ConflictingRetry,
} from "@/lib/xero-operation-resolve-guards";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";

/**
 * #3635 review N5: a mark another officer just wrote may still be withdrawn
 * (it is checked against running retries after it is written), so "already
 * resolved" is answered only when the same check would keep it. #4421 review
 * (concurrency F6): an officer who offered a note is told which note the mark
 * recorded, and refused when it is not the one they offered.
 */
async function answerExistingMark(
  id: string,
  mark: { manuallyResolvedAt: Date; xeroObjectNumber: string | null },
  offeredNumber: string | undefined,
): Promise<{ refused: { status: number; message: string } } | { message: string }> {
  const conflict: ConflictingRetry | null = await findRetryOverlappingMark(id, mark.manuallyResolvedAt);
  if (conflict) return { refused: { status: 409, message: retryRunningRefusal(conflict) } };
  if (offeredNumber) {
    const message = alreadyResolvedWithNoteMessage(mark.xeroObjectNumber);
    return mark.xeroObjectNumber === offeredNumber ? { message } : { refused: { status: 409, message } };
  }
  return { message: "Xero operation was already resolved." };
}

const resolveSchema = z.object({
  reason: z.string().trim().min(XERO_OPERATION_REASON_MIN).max(XERO_OPERATION_REASON_MAX),
  // #4421: the Xero credit note the officer made, asked of a FAILED payment
  // refund note's create that names no note of its own
  // (`refundNoteResolveShape`). Refused for every other row (review, money F5).
  creditNoteNumber: z.string().trim().max(HAND_MADE_CREDIT_NOTE_NUMBER_MAX).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid resolve payload", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { id } = await params;
  const offeredNumber = parsed.data.creditNoteNumber || undefined;

  /** The route's one audit write: a mark kept, or (#4421) a refusal or a withdrawal. */
  const audit = (entry: { outcome: "success" | "failure"; summary: string; details: string; metadata: Record<string, unknown> }) =>
    createAuditLog({
      action: "xero.operation.manually_resolved",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: id,
      entityType: "XeroSyncOperation",
      entityId: id,
      category: "xero",
      severity: "important",
      outcome: entry.outcome,
      summary: entry.summary,
      details: entry.details,
      metadata: entry.metadata,
    });
  /** An audit failure is logged, never the officer's answer. */
  const auditFailure = (summary: string, details: string, metadata: Record<string, unknown>) =>
    audit({ outcome: "failure", summary, details, metadata }).catch((error: unknown) =>
      logger.error({ err: error, operationId: id }, "Could not audit a refused resolve (#4421)"),
    );
  /**
   * #4421 review (security F6, round 2): EVERY refusal of a resolve that
   * offered a credit note number, or of a row that needs one, is audited with
   * the number tried and the status - whichever check refused it.
   */
  let auditsRefusals = offeredNumber !== undefined;
  const refuse = async (status: number, message: string) => {
    if (auditsRefusals) {
      await auditFailure("Xero operation not marked resolved: its credit note was refused", message, {
        operationId: id,
        creditNoteNumber: offeredNumber ?? null,
        status,
      });
    }
    return NextResponse.json({ error: message }, { status });
  };
  const answerMark = async (mark: { manuallyResolvedAt: Date; xeroObjectNumber: string | null }) => {
    const answer = await answerExistingMark(id, mark, offeredNumber);
    return "refused" in answer ? refuse(answer.refused.status, answer.refused.message) : NextResponse.json({ ok: true, message: answer.message });
  };

  try {
    // #4421 review (concurrency F1): the instant the row was read. A retry of
    // it that started or finished since is refused under the claim's lock.
    const readAt = new Date();
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id },
    });

    if (!operation) {
      return NextResponse.json({ error: "Xero operation not found." }, { status: 404 });
    }

    // #4421 (owner decision 26 Oct 2026, `INV-INT-028`): a FAILED payment
    // refund note's create that names no note of its own is resolved only with
    // the note the officer made, checked in Xero below - before any
    // transaction, so no lock is held across the provider call - and recorded
    // with the resolve. Read first, so every refusal of such a row is audited.
    const shape = refundNoteResolveShape(operation);
    auditsRefusals ||= shape.kind === "asks-number";

    if (isResolvedInXero(operation) && operation.manuallyResolvedAt) {
      return answerMark({ manuallyResolvedAt: operation.manuallyResolvedAt, xeroObjectNumber: operation.xeroObjectNumber });
    }

    if (operation.status === "RUNNING") {
      // #3635 decision 3: a retry that claimed the operation itself.
      return refuse(409, retryRunningRefusal(operation));
    }

    if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
      return refuse(409, "Only failed or partially-completed Xero operations can be resolved.");
    }

    // #3635 decision 1 (`INV-INT-025`): resolving does not converge the local
    // credit ledger, and a resolved deallocation would fence the booking's
    // cancel and credit writes for good.
    if (isAppliedCreditLedgerOperation(operation)) {
      return refuse(
        409,
        "An applied-credit allocation or deallocation cannot be marked resolved in Xero, because fixing Xero by hand does not bring the club's own credit ledger back in line. Retry it instead.",
      );
    }

    // #3635 review N3: a live copy of the same document queued beside this one
    // would mint a second document after the mark (re-checked under the
    // claim's locks for a recorded note).
    if (await findQueuedLiveCopy(operation)) {
      return refuse(409, QUEUED_LIVE_COPY_REFUSAL);
    }

    if (shape.kind === "refused") {
      return refuse(409, shape.message);
    }
    if (shape.kind !== "asks-number" && offeredNumber) {
      return refuse(409, RESOLVE_NOTE_NOT_ASKED_MESSAGE);
    }
    let recordedNote: VerifiedHandMadeRefundNote | null = null;
    let resolvedAt = new Date();
    let claimed: boolean;
    if (shape.kind === "asks-number") {
      if (!offeredNumber) {
        return refuse(400, RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE);
      }
      // Review round 2: a run that already raised this row's note - before
      // the Xero check, so none is spent; the claim asks again under its locks.
      if (await findSupersedingRefundNoteRun(operation)) {
        return refuse(409, RESOLVE_NOTE_SUPERSEDED_MESSAGE);
      }
      try {
        recordedNote = await verifyResolvedRefundNote({ shape, creditNoteNumber: offeredNumber, format: await clubFormatValues() });
        // #4421: the note is claimed with the resolve, under `lock(1)` and
        // the Payment row, refused when anything here already records it.
        const claim = await claimResolveRecordingRefundNote({
          operationId: id,
          paymentId: shape.paymentId,
          note: recordedNote,
          readAt,
          reason: parsed.data.reason,
          resolvedById: session.user.id,
        });
        claimed = claim.outcome === "claimed";
        if (claim.outcome === "claimed") resolvedAt = claim.resolvedAt;
      } catch (error) {
        if (error instanceof ManualBookingPaymentError) return refuse(error.status, error.message);
        throw error;
      }
    } else {
      // #3635 (`INV-INT-025`): status-guarded, the mirror of the retry claims'
      // `manuallyResolvedAt: null` guard, so a retry that claimed the row
      // after the read above wins.
      claimed =
        (
          await prisma.xeroSyncOperation.updateMany({
            where: {
              id,
              status: { in: ["FAILED", "PARTIAL"] },
              manuallyResolvedAt: null,
            },
            data: {
              manuallyResolvedAt: resolvedAt,
              manuallyResolvedReason: parsed.data.reason,
              manuallyResolvedById: session.user.id,
            },
          })
        ).count === 1;
    }
    if (!claimed) {
      const current = await prisma.xeroSyncOperation.findUnique({
        where: { id },
        select: { manuallyResolvedAt: true, status: true, startedAt: true, xeroObjectNumber: true },
      });
      if (current?.manuallyResolvedAt) {
        return answerMark({ manuallyResolvedAt: current.manuallyResolvedAt, xeroObjectNumber: current.xeroObjectNumber });
      }
      if (current?.status === "RUNNING") return refuse(409, retryRunningRefusal(current));
      return refuse(409, "This Xero operation changed while it was being resolved. Reload it and check before resolving.");
    }

    // #3635 decision 3: a queued retry of this operation that the drain has
    // claimed runs while the operation row still reads FAILED. Checked AFTER
    // the mark is written: a drain that read the row before the mark landed
    // had already claimed its queued row, so this read sees it - still RUNNING,
    // or finished in the moments since (review N4) - and the mark is withdrawn;
    // a drain that reads after the mark refuses to run.
    const runningRetry = await findRetryOverlappingMark(id, resolvedAt);
    if (runningRetry) {
      if (recordedNote && shape.kind === "asks-number") {
        return withdrawRecordedNote({
          operationId: id,
          paymentId: shape.paymentId,
          resolvedAt,
          note: recordedNote,
          previousXeroObjectType: operation.xeroObjectType,
          retryRefusal: retryRunningRefusal(runningRetry),
          auditFailure,
        });
      }
      await prisma.xeroSyncOperation.updateMany({
        where: { id, manuallyResolvedAt: resolvedAt },
        data: {
          manuallyResolvedAt: null,
          manuallyResolvedReason: null,
          manuallyResolvedById: null,
        },
      });
      return refuse(409, retryRunningRefusal(runningRetry));
    }

    // #4421 review (money F1): the recorded note read from Xero once more,
    // outside any lock, so a void that landed since the check marks its new
    // link voided at once - and the coverage readers then count it as nothing.
    if (recordedNote) {
      await reconcileHandMadeNoteAfterRecording(recordedNote, {
        alertKey: "xero-resolve-hand-made-note",
        recordedFor: "a refund credit note resolved by hand",
      });
    }

    await audit({
      outcome: "success",
      summary: "Xero operation marked resolved in Xero",
      details: parsed.data.reason,
      metadata: {
        operationId: operation.id,
        direction: operation.direction,
        entityType: operation.entityType,
        operationType: operation.operationType,
        localModel: operation.localModel,
        localId: operation.localId,
        previousStatus: operation.status,
        ...(recordedNote
          ? { creditNoteId: recordedNote.creditNoteId, creditNoteNumber: recordedNote.creditNoteNumber, amountCents: recordedNote.amountCents }
          : {}),
      },
    });

    return NextResponse.json({
      ok: true,
      message: recordedNote
        ? `Xero operation marked resolved, recording credit note ${recordedNote.creditNoteNumber}; it will drop off the active failure list.`
        : "Xero operation marked resolved; it will drop off the active failure list.",
    });
  } catch (error) {
    logger.error({ err: error, operationId: id }, "Failed to resolve Xero operation");
    return NextResponse.json(
      { error: "Failed to resolve Xero operation" },
      { status: 500 }
    );
  }
}

/**
 * #4421 review (round 2): a mark that recorded a note, withdrawn because a
 * retry turned out to be running beside it. The withdrawal is audited (the
 * note was written and is now taken back). If it fails - its transaction takes
 * `lock(1)` and the Payment row - the mark and the live link stay committed
 * while a retry may raise its own note: the double-note case the withdrawal
 * exists to stop. So that failure raises a refund-ledger alert naming the
 * operation and the note, is audited, and the officer is told.
 */
async function withdrawRecordedNote(input: {
  operationId: string;
  paymentId: string;
  resolvedAt: Date;
  note: VerifiedHandMadeRefundNote;
  previousXeroObjectType: string | null;
  retryRefusal: string;
  auditFailure: (summary: string, details: string, metadata: Record<string, unknown>) => Promise<unknown>;
}) {
  const metadata = {
    operationId: input.operationId,
    creditNoteId: input.note.creditNoteId,
    creditNoteNumber: input.note.creditNoteNumber,
    amountCents: input.note.amountCents,
  };
  try {
    await withdrawResolveRecordingRefundNote({
      operationId: input.operationId,
      paymentId: input.paymentId,
      resolvedAt: input.resolvedAt,
      creditNoteId: input.note.creditNoteId,
      previousXeroObjectType: input.previousXeroObjectType,
    });
  } catch (error) {
    logger.error({ err: error, ...metadata }, "Could not withdraw a resolve that recorded a hand-made refund credit note while a retry runs (#4421)");
    await notifyXeroSyncError({
      errorType: "refund-ledger-divergence",
      operation: `xero-resolve-withdraw:${input.operationId}`,
      errorMessage: `Xero operation ${input.operationId} was marked resolved by hand, recording credit note ${input.note.creditNoteNumber}, while a retry of it was running, and the app could not take that mark back. The retry may raise its own credit note for the same refund: check Xero for two notes and void one.`,
    }).catch(() => undefined);
    await input.auditFailure("Resolve by hand recorded a credit note it could not withdraw while a retry ran", RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE, {
      ...metadata,
      result: "withdrawal failed: retry running",
      status: 500,
    });
    return NextResponse.json({ error: RESOLVE_NOTE_WITHDRAW_FAILED_MESSAGE }, { status: 500 });
  }
  await input.auditFailure("Resolve by hand withdrawn: a retry was running", input.retryRefusal, {
    ...metadata,
    result: "withdrawn: retry running",
    status: 409,
  });
  return NextResponse.json({ error: input.retryRefusal }, { status: 409 });
}
