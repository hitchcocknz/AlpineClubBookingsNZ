/**
 * #4219 — bring the credit ledger into line with Xero when a credit note was
 * spent there by something the app did not do (an offset, a payment made against
 * the note, a manual allocation).
 *
 * The treasurer's entry in Xero is the decision, so the app mirrors it with no
 * officer step (owner decision, 17 Oct 2026): the lot the note funded is written
 * down, the booking's applied credit is released, and the failed allocation is
 * closed. No money moves: the member's credit balance is the same before and
 * after, the member owes the released amount on the booking's invoice, and Xero's
 * receivable already shows it. Nothing is written to Xero.
 *
 * The signal is #4218's named failure, raised only after a read of the note
 * confirmed Xero's refusal, so `remainingCents` here is Xero's own figure.
 *
 * ONE TRANSACTION, global lock then the member's credit-ledger lock
 * (`INV-LOCK-002`): releasing applied credit changes what the booking owes, so
 * it excludes the cancel, capture and refund writers that take the global key as
 * well as the credit writers that take the member's. Everything is re-read under
 * the locks. The routine is idempotent without a separate flag: the write-down
 * counts in the next calculation of what the note should still hold, so a second
 * call finds nothing missing and writes nothing.
 *
 * It FAILS CLOSED. Anything it cannot account for (no single slice for the note,
 * a slice Xero already holds, a note shared by several lots, a booking its cancel
 * settled) writes nothing and says why; the caller keeps the original failure.
 */
import { CreditType } from "@prisma/client";
import { isCreditNoteSpentOutsideAppError } from "./xero-credit-note-spent-outside-app";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { createAuditLog } from "./audit";
import { bookingOwner } from "@/lib/booking-owner";
import { syncBookingLedgerCredits } from "@/lib/booking-ledger-credit-sync";
import { deriveBookingAppliedCreditCents, lockMemberCreditLedger } from "./member-credit";
import { appliedCreditSettledByCancel, unallocatedAppliedCents } from "./xero-applied-credit-ledger-state";
import { assertNoAppliedCreditDeallocationFence } from "./xero-applied-credit-operation-serialization";
import {
  CREDIT_NOTE_WRITE_DOWN_TYPE,
  creditNoteReleaseDescription,
  creditNoteWriteDownDescription,
  writtenDownCentsByCreditNote,
} from "./xero-credit-note-write-down";

/** `XeroSyncOperation.manuallyResolvedReason` for a failure this routine closed. */
export const CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON =
  "CREDIT_SPENT_OUTSIDE_APP: the credit note was used in Xero outside the app; the credit ledger was brought into line with Xero (#4219).";

const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";

export type ConvergeRefusal =
  | "no-payment-or-owner"
  | "settled-by-cancel"
  | "no-single-slice"
  | "already-converged"
  | "slice-already-in-xero"
  | "shared-credit-note"
  | "nothing-missing";

export type ConvergeResult =
  | { converged: true; writtenDownCents: number; sliceRemovedCents: number; closedOperations: number }
  | { converged: false; reason: ConvergeRefusal };

export async function convergeCreditNoteSpentOutsideApp(input: {
  bookingId: string;
  creditNoteId: string;
  /** What Xero says the note still holds, in cents (confirmed by #4218's read). */
  remainingCents: number;
}): Promise<ConvergeResult> {
  const { bookingId, creditNoteId, remainingCents } = input;
  if (!Number.isInteger(remainingCents) || remainingCents < 0) {
    throw new Error(`Credit note remaining credit must be non-negative integer cents, got ${remainingCents}.`);
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });
  const ownerMemberId = booking ? bookingOwner(booking).memberId : null;
  if (!booking?.payment || !ownerMemberId) return { converged: false, reason: "no-payment-or-owner" };
  const paymentId = booking.payment.id;

  const result = await prisma.$transaction(async (tx): Promise<ConvergeResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lockMemberCreditLedger(ownerMemberId, tx);

    // Re-read everything the decision rests on, under the locks.
    if (await appliedCreditSettledByCancel(bookingId, tx)) {
      return { converged: false, reason: "settled-by-cancel" };
    }
    await assertNoAppliedCreditDeallocationFence(paymentId, tx);

    const slices = await tx.memberCreditNoteAllocation.findMany({
      where: { appliedToBookingId: bookingId, xeroCreditNoteId: creditNoteId },
    });
    const [slice, ...otherBookingSlices] = slices;
    if (!slice && (await unallocatedAppliedCents(bookingId, tx)) === 0) {
      // A concurrent run converged this booking first: nothing is left to allocate.
      return { converged: false, reason: "already-converged" };
    }
    if (!slice || otherBookingSlices.length > 0) return { converged: false, reason: "no-single-slice" };
    const heldInXero = await tx.xeroObjectLink.findFirst({
      where: {
        localModel: "MemberCreditNoteAllocation",
        localId: slice.id,
        xeroObjectType: "ALLOCATION",
        role: APPLIED_CREDIT_ALLOCATION_ROLE,
        active: true,
      },
      select: { id: true },
    });
    if (heldInXero) return { converged: false, reason: "slice-already-in-xero" };

    const lots = await tx.memberCredit.findMany({
      where: { memberId: ownerMemberId, xeroCreditNoteId: creditNoteId, amountCents: { gt: 0 } },
      select: { id: true, amountCents: true },
    });
    const [lot, ...otherLots] = lots;
    if (!lot || otherLots.length > 0 || lot.id !== slice.memberCreditId) {
      return { converged: false, reason: "shared-credit-note" };
    }

    // What the app's ledger says the note held free before this booking's slice,
    // against what Xero says it holds: the difference is spent outside the app.
    const [otherSlices, writtenDown] = await Promise.all([
      tx.memberCreditNoteAllocation.aggregate({
        where: { memberCreditId: lot.id, id: { not: slice.id } },
        _sum: { amountCents: true },
      }),
      writtenDownCentsByCreditNote(tx, ownerMemberId, [creditNoteId]),
    ]);
    const freeBeforeSliceCents =
      lot.amountCents - (otherSlices._sum.amountCents ?? 0) - (writtenDown.get(creditNoteId) ?? 0);
    const outsideSpendCents = freeBeforeSliceCents - remainingCents;
    const downCents = Math.min(slice.amountCents, outsideSpendCents);
    if (downCents <= 0) return { converged: false, reason: "nothing-missing" };

    // Additive rows, never edits. Release the booking's applied credit and write
    // the lot down by the same amount: the member's balance does not move.
    await tx.memberCredit.create({
      data: {
        memberId: ownerMemberId,
        amountCents: downCents,
        type: CreditType.BOOKING_APPLIED,
        description: creditNoteReleaseDescription(bookingId),
        appliedToBookingId: bookingId,
      },
    });
    await tx.memberCredit.create({
      data: {
        memberId: ownerMemberId,
        amountCents: -downCents,
        type: CREDIT_NOTE_WRITE_DOWN_TYPE,
        description: creditNoteWriteDownDescription(bookingId),
        xeroCreditNoteId: creditNoteId,
      },
    });
    // The slice Xero never received shrinks (or goes), so every reader that totals
    // a booking's allocations sees only what Xero holds.
    if (downCents >= slice.amountCents) {
      await tx.memberCreditNoteAllocation.delete({ where: { id: slice.id } });
    } else {
      await tx.memberCreditNoteAllocation.update({
        where: { id: slice.id },
        data: { amountCents: slice.amountCents - downCents },
      });
    }
    await syncBookingLedgerCredits({ bookingId, store: tx });
    await tx.payment.update({
      where: { id: paymentId },
      data: { creditAppliedCents: await deriveBookingAppliedCreditCents(bookingId, tx) },
    });

    // Close this slice's failed allocation attempts through the resolution fields
    // an officer's mark uses (`INV-INT-025`): done, never re-run, off the Active list.
    const closed = await tx.xeroSyncOperation.updateMany({
      where: {
        entityType: "ALLOCATION",
        localModel: "MemberCreditNoteAllocation",
        localId: slice.id,
        status: { in: ["FAILED", "PARTIAL"] },
        manuallyResolvedAt: null,
      },
      data: {
        manuallyResolvedAt: new Date(),
        manuallyResolvedReason: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
      },
    });

    await createAuditLog(
      {
        action: "xero.credit_note.spent_outside_app_converged",
        memberId: ownerMemberId,
        subjectMemberId: ownerMemberId,
        targetId: bookingId,
        entityType: "Booking",
        entityId: bookingId,
        category: "xero",
        severity: "important",
        outcome: "success",
        summary: "Credit note used outside the app: credit ledger brought into line with Xero",
        details: CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
        metadata: {
          creditNoteId,
          writtenDownCents: downCents,
          sliceCentsBefore: slice.amountCents,
          xeroRemainingCents: remainingCents,
          closedOperations: closed.count,
        },
      },
      tx,
    );
    return {
      converged: true,
      writtenDownCents: downCents,
      sliceRemovedCents: downCents,
      closedOperations: closed.count,
    };
  });

  if (!result.converged) {
    logger.warn(
      { bookingId, creditNoteId, reason: result.reason },
      "Credit note used outside the app was not converged; the original failure stands",
    );
  } else {
    logger.info(
      { bookingId, creditNoteId, writtenDownCents: result.writtenDownCents },
      "Converged the credit ledger with a credit note used outside the app",
    );
  }
  return result;
}

/** Re-plans after a converge are bounded: each one removes a slice or fails closed. */
const MAX_CONVERGE_ATTEMPTS = 3;

/**
 * The worker's entry: did this failure get converged, so the allocation should be
 * planned again? True only for #4218's confirmed named failure, with attempts
 * left, when the routine converged. Anything else leaves the failure standing.
 */
export async function convergedForNamedFailure(
  error: unknown,
  bookingId: string,
  attemptsSoFar = 0,
): Promise<boolean> {
  if (!isCreditNoteSpentOutsideAppError(error) || attemptsSoFar >= MAX_CONVERGE_ATTEMPTS) {
    return false;
  }
  const result = await convergeCreditNoteSpentOutsideApp({
    bookingId,
    creditNoteId: error.creditNoteId,
    remainingCents: error.remainingCents,
  });
  // "already-converged": a concurrent run did it, so plan again - there is
  // nothing left to allocate and the operation completes.
  return result.converged || result.reason === "already-converged";
}
