import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import logger from "@/lib/logger";
import { isResolvedInXero } from "@/lib/xero-operation-resolution";
import { isAppliedCreditLedgerOperation } from "@/lib/xero-applied-credit-operation-serialization";
import { HAND_MADE_CREDIT_NOTE_NUMBER_MAX } from "@/lib/bank-refund-void-follow-up-copy";
import { clubFormatValues } from "@/lib/club-format-server";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import type { VerifiedHandMadeRefundNote } from "@/lib/bank-refund-void-answer";
import {
  claimResolveRecordingRefundNote,
  refundNoteResolveShape,
  RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE,
  RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE,
  verifyResolvedRefundNote,
  withdrawResolveRecordingRefundNote,
} from "@/lib/xero-resolve-refund-note";
import {
  findQueuedLiveCopy,
  findRetryOverlappingMark,
  retryRunningRefusal,
  type ConflictingRetry,
} from "@/lib/xero-operation-resolve-guards";

function retryRunning(retry: { status: string; startedAt: Date | null } | null) {
  return NextResponse.json({ error: retryRunningRefusal(retry) }, { status: 409 });
}

/**
 * #3635 review N5: a mark another officer just wrote may still be withdrawn
 * (it is checked against running retries after it is written), so "already
 * resolved" is answered only when the same check would keep it.
 */
async function answerExistingMark(id: string, markAt: Date) {
  const conflict: ConflictingRetry | null = await findRetryOverlappingMark(id, markAt);
  if (conflict) return retryRunning(conflict);
  return NextResponse.json({ ok: true, message: "Xero operation was already resolved." });
}

const resolveSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  // #4421: the Xero credit note the officer made, asked of a payment refund
  // note's create that names no note of its own (`refundNoteResolveShape`).
  // Ignored for every other row, which resolves as before.
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

  try {
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id },
    });

    if (!operation) {
      return NextResponse.json({ error: "Xero operation not found." }, { status: 404 });
    }

    if (isResolvedInXero(operation) && operation.manuallyResolvedAt) {
      return answerExistingMark(id, operation.manuallyResolvedAt);
    }

    if (operation.status === "RUNNING") {
      // #3635 decision 3: a retry that claimed the operation itself.
      return retryRunning(operation);
    }

    if (operation.status !== "FAILED" && operation.status !== "PARTIAL") {
      return NextResponse.json(
        { error: "Only failed or partially-completed Xero operations can be resolved." },
        { status: 409 }
      );
    }

    // #3635 decision 1 (`INV-INT-025`): resolving does not converge the local
    // credit ledger, and a resolved deallocation would fence the booking's
    // cancel and credit writes for good.
    if (isAppliedCreditLedgerOperation(operation)) {
      return NextResponse.json(
        {
          error:
            "An applied-credit allocation or deallocation cannot be marked resolved in Xero, because fixing Xero by hand does not bring the club's own credit ledger back in line. Retry it instead.",
        },
        { status: 409 }
      );
    }

    // #3635 review N3: a live copy of the same document queued beside this one
    // would mint a second document after the mark.
    if (await findQueuedLiveCopy(operation)) {
      return NextResponse.json(
        {
          error:
            "A new copy of this Xero document is queued. Wait for it to run or cancel it, then check Xero before resolving this one.",
        },
        { status: 409 }
      );
    }

    // #4421 (owner decision 26 Oct 2026, `INV-INT-028`): a payment refund
    // note's create that names no note of its own is resolved only with the
    // note the officer made, checked in Xero here - before any transaction,
    // so no lock is held across the provider call - and recorded with the
    // resolve below.
    const shape = refundNoteResolveShape(operation);
    if (shape.kind === "unreadable") {
      return NextResponse.json({ error: RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE }, { status: 409 });
    }
    let recordedNote: VerifiedHandMadeRefundNote | null = null;
    if (shape.kind === "asks-number") {
      if (!parsed.data.creditNoteNumber) {
        return NextResponse.json({ error: RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE }, { status: 400 });
      }
      recordedNote = await verifyResolvedRefundNote({
        shape,
        creditNoteNumber: parsed.data.creditNoteNumber,
        format: await clubFormatValues(),
      });
    }

    // #3635 (`INV-INT-025`): status-guarded, the mirror of the retry claims'
    // `manuallyResolvedAt: null` guard, so a retry that claimed the row after
    // the read above wins. #4421: a recorded note is claimed with the resolve,
    // under `lock(1)`, refused when anything here already records it.
    const resolvedAt = new Date();
    const claimed = recordedNote
      ? await claimResolveRecordingRefundNote({
          operationId: id,
          note: recordedNote,
          resolvedAt,
          reason: parsed.data.reason,
          resolvedById: session.user.id,
        })
      : (
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
    if (!claimed) {
      const current = await prisma.xeroSyncOperation.findUnique({
        where: { id },
        select: { manuallyResolvedAt: true, status: true, startedAt: true },
      });
      if (current?.manuallyResolvedAt) return answerExistingMark(id, current.manuallyResolvedAt);
      if (current?.status === "RUNNING") return retryRunning(current);
      return NextResponse.json(
        {
          error:
            "This Xero operation changed while it was being resolved. Reload it and check before resolving.",
        },
        { status: 409 }
      );
    }

    // #3635 decision 3: a queued retry of this operation that the drain has
    // claimed runs while the operation row still reads FAILED. Checked AFTER
    // the mark is written: a drain that read the row before the mark landed
    // had already claimed its queued row, so this read sees it - still RUNNING,
    // or finished in the moments since (review N4) - and the mark is withdrawn;
    // a drain that reads after the mark refuses to run.
    const runningRetry = await findRetryOverlappingMark(id, resolvedAt);
    if (runningRetry) {
      if (recordedNote) {
        await withdrawResolveRecordingRefundNote({
          operationId: id,
          resolvedAt,
          creditNoteId: recordedNote.creditNoteId,
          previousXeroObjectType: operation.xeroObjectType,
        });
      } else {
        await prisma.xeroSyncOperation.updateMany({
          where: { id, manuallyResolvedAt: resolvedAt },
          data: {
            manuallyResolvedAt: null,
            manuallyResolvedReason: null,
            manuallyResolvedById: null,
          },
        });
      }
      return retryRunning(runningRetry);
    }

    await createAuditLog({
      action: "xero.operation.manually_resolved",
      memberId: session.user.id,
      actorMemberId: session.user.id,
      targetId: operation.id,
      entityType: "XeroSyncOperation",
      entityId: operation.id,
      category: "xero",
      severity: "important",
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
    // #4421: the note check's and the claim's refusals, in words the officer reads.
    if (error instanceof ManualBookingPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, operationId: id }, "Failed to resolve Xero operation");
    return NextResponse.json(
      { error: "Failed to resolve Xero operation" },
      { status: 500 }
    );
  }
}
