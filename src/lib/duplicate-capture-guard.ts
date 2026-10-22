/**
 * THE DUPLICATE-CAPTURE GUARD (#1992, #4211, `INV-PAY-043`): what a card
 * capture arriving on an already-PAID booking is.
 *
 * `already_paid` is the exactly-once replay outcome for a success that carries
 * the intent that settled the booking: webhook redelivery, the confirm-payment
 * route racing the webhook, payment-link reconcile, charge-saved-method and
 * cron-confirm-pending reruns replaying the attempt row's OWN intent (#3267),
 * confirm-pending-guests retries. A DIFFERENT capture on a PAID booking is
 * double money - the residual #1967 split-child window, where the /pay link
 * intent and the settlement cron's saved-card charge both capture, or a member
 * paying from three stale tabs (#4211) - and is refunded automatically.
 *
 * WHICH CAPTURE SETTLED THE BOOKING IS RECORDED, NOT GUESSED (#4211, owner
 * decision 17 Oct 2026, "Record the settler"). The settle's PAID claim writes
 * `Payment.settledByTransactionId` (`payment-settler.ts`). Guessing it from the
 * ledger failed in three ways: a third capture the pre-#4211 guard kept, a
 * Xero bank receipt recorded after the card paid (#3638), and a superseded
 * capture whose refund failed later (#4227) each looked like "another capture
 * holding money", so a REPLAY of the real settlement was refunded. Nor does
 * "the arriving row was already SUCCEEDED" tell a replay apart: every
 * saved-card path writes its attempt row SUCCEEDED before it settles.
 *
 * 1. **The recorded settler is never refunded.** Its replay is kept whatever
 *    else holds money on the booking.
 * 2. **Any other arriving capture is refunded** while the recorded settler
 *    still holds net cash that neither the superseded-intent machinery nor a
 *    duplicate-capture refund owns. A capture a duplicate-capture refund
 *    already owns re-sends only its own frozen refund (one operation per
 *    booking and intent, so the replay is idempotent).
 * 3. **No usable record** - paid before this release, by the draining old
 *    colour, or a settler that no longer holds money - and another capture
 *    holds money (`otherSettledCaptureWhere`): the arriving capture is KEPT
 *    and the admins are told to check by hand. Nothing is refunded
 *    automatically, because nothing says which side is the settlement. A
 *    capture a duplicate-capture refund already owns still re-sends its own
 *    refund, which an earlier delivery decided.
 *
 * Every read runs under the lock(1) every caller of `markBookingPaymentSucceeded`
 * holds, so the check-then-enqueue cannot interleave with another settlement,
 * and the caller enqueues the refund in the same transaction, before any
 * Stripe call (the #1349 pattern).
 */
import {
  PaymentSource,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { claimAlertCooldownFailOpen, SETTLEMENT_MONEY_ALERT_REPEAT_MS } from "@/lib/alert-cooldown-fail-open";
import type { ClubFormat } from "@/lib/club-format";
import { listDuplicateCaptureRefundIntentIds } from "@/lib/duplicate-capture-ownership";
import { releaseAlertCooldown } from "@/lib/alert-cooldown";
import type { DuplicateCaptureKeptReason } from "@/lib/duplicate-capture-kept-note";
import { sendAdminDuplicateCaptureKeptAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { findPaymentTransactionByIntentId } from "@/lib/payment-transactions";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import {
  findLiveSupersededIntentOperation,
  listLiveSupersededIntentIds,
} from "@/lib/superseded-intent-ownership";

/**
 * Which captures could be the settlement an arriving capture duplicates:
 * another captured PRIMARY row with net cash - a Stripe one under a different
 * intent that no superseded-intent operation (b′) and no duplicate-capture
 * refund (c, #4211) owns, or any non-Stripe one (#2262; the row this
 * settlement just wrote is always STRIPE, so it never matches that arm).
 * Fully REFUNDED rows are history, so a #1765 repay generation is never a
 * duplicate of its refunded predecessor. (b′) because a superseded intent's
 * late capture is handed to its own refund WITHOUT passing through the
 * settlement, so from the ledger alone it looks like one. Exported so the
 * real-PostgreSQL proofs repeat the exact read.
 */
export function otherSettledCaptureWhere(input: {
  paymentId: string;
  arrivingPaymentIntentId: string;
  liveSupersededIntentIds: string[];
  duplicateRefundIntentIds: string[];
}) {
  return {
    paymentId: input.paymentId,
    kind: PaymentTransactionKind.PRIMARY,
    status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
    OR: [
      {
        source: PaymentSource.STRIPE,
        stripePaymentIntentId: {
          not: input.arrivingPaymentIntentId,
          notIn: [...input.liveSupersededIntentIds, ...input.duplicateRefundIntentIds],
        },
        NOT: { stripePaymentIntentId: null },
      },
      { source: { not: PaymentSource.STRIPE } },
    ],
  } satisfies Prisma.PaymentTransactionWhereInput;
}

/** The single slice a duplicate's refund takes: exactly its own capture. */
type DuplicateRefundSlice = { paymentTransactionId: string; amountCents: number };

export type ArrivingCaptureVerdict =
  | { verdict: "keep" }
  /** Rule 3: kept, and the admins check by hand which side to refund. */
  | { verdict: "keep_unrecorded_settler"; otherPaymentIntentId: string | null; reason: DuplicateCaptureKeptReason }
  | {
      verdict: "refund";
      refundPlan: DuplicateRefundSlice[];
      refundCents: number;
      /** The settlement's intent, for the alert and history; null for cash or a bank receipt. */
      settledPaymentIntentId: string | null;
    };

/**
 * Judge a card capture arriving on a booking already PAID. The caller has
 * already recorded the capture on its own row and ruled out refund history
 * (#1765); this only reads.
 */
export async function judgeCaptureOnPaidBooking(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    paymentId: string;
    /** `Payment.settledByTransactionId`, read under the caller's lock(1). */
    recordedSettlerId: string | null;
    paymentIntentId: string;
    amountCents: number;
  },
): Promise<ArrivingCaptureVerdict> {
  const arriving = await findPaymentTransactionByIntentId({
    paymentIntentId: input.paymentIntentId,
    store: tx,
  });
  // Rule 1.
  if (!arriving || arriving.id === input.recordedSettlerId) return { verdict: "keep" };

  const duplicateRefundIntentIds = await listDuplicateCaptureRefundIntentIds({
    bookingId: input.bookingId,
    store: tx,
  });
  const where = otherSettledCaptureWhere({
    paymentId: input.paymentId,
    arrivingPaymentIntentId: input.paymentIntentId,
    liveSupersededIntentIds: await listLiveSupersededIntentIds(tx, input.paymentId),
    duplicateRefundIntentIds,
  });
  const select = { id: true, stripePaymentIntentId: true } as const;
  // Rule 2's settlement: the recorded settler, while it still qualifies.
  const recordedSettler = input.recordedSettlerId
    ? await tx.paymentTransaction.findFirst({ where: { ...where, id: input.recordedSettlerId }, select })
    : null;
  // #4177 (`INV-PAY-133`): with no usable record, the oldest-inserted that qualifies.
  const settlement =
    recordedSettler ??
    (await tx.paymentTransaction.findFirst({ orderBy: [...LEDGER_ROWS_OLDEST_FIRST], where, select }));
  if (!settlement) return { verdict: "keep" };

  // (c′) belt and braces: the settlement's own intent re-checked against the
  // live superseded-intent operations, by a different query shape. If one owns
  // its money, the arriving capture is the settlement side.
  if (
    settlement.stripePaymentIntentId &&
    (await findLiveSupersededIntentOperation(tx, settlement.stripePaymentIntentId))
  ) {
    return { verdict: "keep" };
  }

  if (!recordedSettler && !duplicateRefundIntentIds.includes(input.paymentIntentId)) {
    // Rule 3.
    return {
      verdict: "keep_unrecorded_settler",
      otherPaymentIntentId: settlement.stripePaymentIntentId,
      reason: input.recordedSettlerId ? "settler-released" : "not-recorded",
    };
  }

  // Pinned to exactly this capture's outstanding amount, never a newest-first
  // allocation that could touch the settlement.
  const refundCents = Math.min(input.amountCents, arriving.amountCents - arriving.refundedAmountCents);
  if (refundCents <= 0) return { verdict: "keep" };
  return {
    verdict: "refund",
    refundPlan: [{ paymentTransactionId: arriving.id, amountCents: refundCents }],
    refundCents,
    settledPaymentIntentId: settlement.stripePaymentIntentId,
  };
}

/**
 * Rule 3's alert, after the commit: a card capture was kept on a PAID booking
 * with no usable record of which payment settled it while another payment on it
 * still holds money. Its own unmuteable, delivery-locked template
 * (`admin-duplicate-capture-kept`): the duplicate-capture refund's alert says a
 * refund was made or queued, and the generic payment alert says "Payment Failed"
 * and can be muted. Once a day per (booking, capture) while repeats arrive (a
 * Stripe redelivery, a reconcile or cron re-run), sent anyway if the claim
 * cannot be read (`claimAlertCooldownFailOpen`), and the claim is given back if
 * the send throws so the next repeat tries again (`releaseAlertCooldown`, as
 * `internet-banking-hold-kept.ts`).
 */
export async function alertCaptureKeptWithoutRecordedSettler({
  booking,
  memberName,
  paymentIntentId,
  amountCents,
  otherPaymentIntentId,
  reason,
  format,
}: {
  booking: { id: string; checkIn: Date; checkOut: Date };
  memberName: string;
  paymentIntentId: string;
  amountCents: number;
  otherPaymentIntentId: string | null;
  reason: DuplicateCaptureKeptReason;
  format: ClubFormat;
}) {
  const context = { bookingId: booking.id, paymentIntentId, otherPaymentIntentId, reason };
  const key = `duplicate-capture-unrecorded-settler:${booking.id}:${paymentIntentId}`;
  const claimedAt = new Date();
  const send = await claimAlertCooldownFailOpen({
    key,
    windowMs: SETTLEMENT_MONEY_ALERT_REPEAT_MS,
    now: claimedAt,
    context,
    logMessage: "Could not claim the kept-capture alert's cooldown; alerting anyway (#4211)",
  });
  logger.error(context, "A card capture on a paid booking with no usable settlement record was kept for an admin to check (#4211)");
  if (!send) return;
  try {
    await sendAdminDuplicateCaptureKeptAlert({
      memberName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      bookingId: booking.id,
      reason,
      amountCents,
      paymentIntentId,
      otherPaymentIntentId,
    }, format);
  } catch (err) {
    logger.error({ err, ...context }, "Failed to alert admins about a kept capture; giving the claim back so a repeat tries again (#4211)");
    await releaseAlertCooldown({ key, claimedAt }).catch((releaseErr) =>
      logger.error({ err: releaseErr, ...context }, "Failed to give back the kept-capture alert's claim (#4211)"),
    );
  }
}
