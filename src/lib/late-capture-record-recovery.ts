import { BookingStatus, PaymentTransactionKind } from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  announceAutomaticLateCaptureRefund,
  readCaptureLandedAfterCancellation,
  recordAutomaticLateCaptureRefund,
  type CancelledBookingLateCapture,
} from "@/lib/cancelled-booking-late-capture";
import type { ClubFormat } from "@/lib/club-format";
import { getClubFormat } from "@/lib/club-format-settings";
import type { CancelledBookingLateCaptureKind } from "@/lib/deleted-booking-modification-payment";
import { queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { isLateCaptureRefundMetadata } from "@/lib/payment-recovery-keys";
import { isRecordedRefundStatus, isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";

/**
 * #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): THE RECORD OF AN AUTOMATIC
 * LATE-CAPTURE REFUND IS WRITTEN ONCE, EVEN WHEN THE DELIVERY THAT REFUNDED DIES.
 *
 * Both late-capture handlers refund at Stripe and then write the record: the
 * already-`DISMISSED` task (`recordAutomaticLateCaptureRefund`), the
 * `refunded_after_cancellation` audit entry, the one alert and the per-capture
 * Xero note. That is `finishAutomaticLateCaptureRefund`, the one epilogue.
 *
 * Before #4149, a process that died, or a record write that failed, after the
 * refund was made and recorded left NO record for good: a redelivery found the
 * capture refunded and acknowledged it (`acknowledgeSettledLateNotice`), and
 * with no task row the intent was not a known late capture
 * (`findLateCapturePaymentIntents`), so the nightly self-heal counted its
 * refund as note-eligible cash and raised a whole-capture card note against the
 * pre-cancel invoice - an over-note for money Xero never received.
 *
 * Now:
 *  - a lost record write answers 500 (`LateCaptureRecordLostError`) instead of
 *    200, so Stripe redelivers. That used to replay the whole refund path; since
 *    #3639 a replay after a refund never refunds again;
 *  - a redelivery that finds the capture refunded with no task row asks Stripe
 *    whether the late-capture refund door sent that refund (its own metadata,
 *    `isLateCaptureRefundMetadata`) and, if it did, runs the same epilogue
 *    (`recoverLostLateCaptureRecord`);
 *  - the nightly self-heal runs the same check before it raises any note
 *    (`recoverLostLateCaptureRecordsForPayment`), so a capture whose
 *    redeliveries never arrive is recorded there and its refund leaves the
 *    note-eligible cash; one it cannot check is not noted that night.
 *
 * EXACTLY ONCE. The task row is the claim: `recordAutomaticCancelledBookingRefundTask`
 * creates it under `pg_advisory_xact_lock(1)` and answers a later writer
 * `alreadyRecorded: "self"` (`recordedBefore`), and only the writer that made
 * the row writes the audit entry and sends the alert. So two redeliveries, a
 * redelivery racing the original, and a retried lost write give one row, one
 * entry and one alert. The note is sized against the notes already raised for
 * the capture (`noteLateCaptureRefunds`), so every writer may ask for it.
 *
 * Not covered, and stated: a process that dies between the row's commit and
 * the audit entry and alert (no awaited call sits between them), and a capture
 * whose refund door left no metadata of its own (a Stripe dashboard refund),
 * which stays the repair tool's.
 */

/** The record write was lost after the refund: the webhook answers 500 so Stripe redelivers and the record is written then. */
export class LateCaptureRecordLostError extends Error {
  constructor(capture: Pick<CancelledBookingLateCapture, "bookingId" | "paymentIntentId">) {
    super(
      `The automatic refund of late capture ${capture.paymentIntentId} on booking ${capture.bookingId} went out but its record could not be written; Stripe's redelivery writes it (#4149)`,
    );
    this.name = "LateCaptureRecordLostError";
  }
}

/**
 * The one epilogue of an automatic late-capture refund, for both webhook
 * handlers and the recovery below: the record (awaited; a lost write throws
 * `LateCaptureRecordLostError`), then, from the delivery that wrote it, the
 * `booking.payment.refunded_after_cancellation` entry and the alert
 * (fire-and-forget - webhooks stay non-blocking), then the per-capture Xero
 * note. `auditDetail` carries what a handler adds to the shared fields.
 */
export async function finishAutomaticLateCaptureRefund(params: {
  capture: CancelledBookingLateCapture;
  format: ClubFormat;
  refundId: string | null;
  auditDetail?: Record<string, unknown>;
}): Promise<void> {
  const { capture, format } = params;
  const recordOutcome = await recordAutomaticLateCaptureRefund(capture);
  // Its own `critical` audit row is written; the 500 brings the redelivery that writes the record.
  if (!recordOutcome.recorded) throw new LateCaptureRecordLostError(capture);

  if (recordOutcome.recordedBefore) {
    logger.info(
      { bookingId: capture.bookingId, paymentIntentId: capture.paymentIntentId },
      "Another delivery already recorded this automatic late-capture refund, its audit entry and its alert (#4149)",
    );
  } else {
    logAudit({
      action: "booking.payment.refunded_after_cancellation",
      category: "payment",
      entityType: "Booking",
      entityId: capture.bookingId,
      targetId: capture.bookingId,
      details: JSON.stringify({
        paymentIntentId: capture.paymentIntentId,
        refundId: params.refundId,
        amountCents: capture.amountCents,
        // #2773: named on both handlers, so the rows are told apart by the row itself.
        kind: lateCaptureAuditKind(capture.captureKind),
        ...params.auditDetail,
      }),
    });
    // #2761 / #2773: the one unmuteable notification for the event (`INV-ADDPAY-037`).
    announceAutomaticLateCaptureRefund(capture, recordOutcome, format).catch((err) =>
      logger.error(
        { err, bookingId: capture.bookingId, paymentIntentId: capture.paymentIntentId, captureKind: capture.captureKind },
        "Failed to send the late-capture cancellation alert",
      ),
    );
  }

  // The corrective Xero credit note, when there is anything to correct (#3635).
  await queueLateCaptureRefundCreditNote({
    paymentId: capture.paymentId,
    paymentIntentId: capture.paymentIntentId,
  });
}

function lateCaptureAuditKind(captureKind: CancelledBookingLateCaptureKind): string {
  return captureKind === "primary" ? "primary" : ADDITIONAL_ASK_INTENT_TYPE;
}

/**
 * The redelivery's half: `true` when this already-refunded capture had lost its
 * record and the epilogue has now written it; `false` when it has a task row of
 * any kind (its record, an operator's, or #3639's approval task) or Stripe
 * holds no refund the late-capture door sent for this booking. Nothing is
 * caught: a read that cannot answer leaves the webhook to answer 500 and Stripe
 * to redeliver, rather than acknowledging a capture whose record is lost.
 */
export async function recoverLostLateCaptureRecord(
  capture: CancelledBookingLateCapture,
  options: { format: ClubFormat; stripeTimeoutMs?: number },
): Promise<boolean> {
  const { bookingId, paymentIntentId } = capture;
  if ((await findLateCapturePaymentIntents([paymentIntentId])).has(paymentIntentId)) return false;
  const sent = (
    await listRefundsForPaymentIntent(
      paymentIntentId,
      options.stripeTimeoutMs ? { timeoutMs: options.stripeTimeoutMs } : undefined,
    )
  ).filter((refund) => isLateCaptureRefundMetadata(refund.metadata, bookingId) && !isRefusedRefundStatus(refund.status));
  const [first] = sent;
  if (!first) return false;

  await finishAutomaticLateCaptureRefund({
    capture,
    format: options.format,
    refundId: first.id,
    auditDetail: {
      refundedCents: sent.reduce((sum, refund) => sum + refund.amount, 0),
      recoveredLostRecord: true,
    },
  });
  logger.warn(
    { bookingId, paymentId: capture.paymentId, paymentIntentId },
    "Wrote the lost record of an automatic late-capture refund (#4149)",
  );
  return true;
}

/** The booking fields a late capture's record and alert name. */
export type LateCaptureRecordBooking = {
  checkIn: Date;
  checkOut: Date;
  deletedAt: Date | null;
  memberId: string | null;
  member: { firstName: string; lastName: string } | null;
  organisation: { name: string; email: string | null } | null;
};

/** One late capture, described from its booking row, for a caller with no webhook payload to hand. */
export function describeLateCaptureFromBooking(
  booking: LateCaptureRecordBooking | null,
  capture: {
    bookingId: string;
    paymentId: string;
    paymentIntentId: string;
    amountCents: number;
    transactionKind: PaymentTransactionKind | null;
  },
): CancelledBookingLateCapture {
  return {
    bookingId: capture.bookingId,
    paymentId: capture.paymentId,
    paymentIntentId: capture.paymentIntentId,
    amountCents: capture.amountCents,
    memberName: readMemberName(booking),
    checkIn: booking?.checkIn ?? new Date(0),
    checkOut: booking?.checkOut ?? new Date(0),
    openingDeletedAt: booking?.deletedAt ?? null,
    captureKind: capture.transactionKind === PaymentTransactionKind.ADDITIONAL ? "modification" : "primary",
  };
}

function readMemberName(booking: LateCaptureRecordBooking | null): string {
  if (!booking) return "unknown member";
  try {
    const owner = bookingOwner(booking);
    return `${owner.member.firstName} ${owner.member.lastName}`.trim();
  } catch (err) {
    logger.warn({ err }, "Late capture's booking has no readable owner");
    return "unknown member";
  }
}

/** A nightly sweep's Stripe read is bounded, as the payments cron's are (#3641). */
const SELF_HEAL_STRIPE_TIMEOUT_MS = 10_000;

/**
 * The nightly self-heal's half (`reconcileCreditBalances`), asked before it
 * queues any refund note for a payment: the payment's refunded captures on a
 * CANCELLED booking that landed after the cancel
 * (`readCaptureLandedAfterCancellation`) and have no task row are checked as a
 * redelivery checks them. `recovered` had lost their record and have it now, so
 * their refunds leave the note-eligible cash; `unresolved` says one could not
 * be checked (Stripe or the record write failed, logged), and the caller raises
 * no note for the payment that night. Never throws.
 */
export async function recoverLostLateCaptureRecordsForPayment(
  paymentId: string,
): Promise<{ recovered: string[]; unresolved: boolean }> {
  const result = { recovered: [] as string[], unresolved: false };
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        bookingId: true,
        booking: {
          select: {
            status: true,
            checkIn: true,
            checkOut: true,
            deletedAt: true,
            memberId: true,
            member: { select: { firstName: true, lastName: true } },
            organisation: { select: { name: true, email: true } },
          },
        },
      },
    });
    if (payment?.booking?.status !== BookingStatus.CANCELLED) return result;
    const refunds = await prisma.paymentRefund.findMany({
      where: { paymentId, stripePaymentIntentId: { not: null } },
      select: { stripePaymentIntentId: true, status: true },
    });
    const intents = [
      ...new Set(
        refunds
          .filter((refund) => isRecordedRefundStatus(refund.status))
          .map((refund) => refund.stripePaymentIntentId)
          .filter((intent): intent is string => Boolean(intent)),
      ),
    ];
    if (intents.length === 0) return result;
    const known = await findLateCapturePaymentIntents(intents);
    let format: ClubFormat | null = null;
    for (const paymentIntentId of intents.filter((intent) => !known.has(intent))) {
      try {
        const capture = await prisma.paymentTransaction.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: { paymentId: true, kind: true, amountCents: true, reason: true },
        });
        if (!capture || capture.paymentId !== paymentId) continue;
        if (!(await readCaptureLandedAfterCancellation({ paymentIntentId, reason: capture.reason }))) continue;
        format ??= await getClubFormat();
        const recovered = await recoverLostLateCaptureRecord(
          describeLateCaptureFromBooking(payment.booking, {
            bookingId: payment.bookingId,
            paymentId,
            paymentIntentId,
            amountCents: capture.amountCents,
            transactionKind: capture.kind,
          }),
          { format, stripeTimeoutMs: SELF_HEAL_STRIPE_TIMEOUT_MS },
        );
        if (recovered) result.recovered.push(paymentIntentId);
      } catch (err) {
        logger.error(
          { err, paymentId, paymentIntentId },
          "Could not check a refunded late capture for a lost record; no refund note is raised for this payment tonight (#4149)",
        );
        result.unresolved = true;
      }
    }
  } catch (err) {
    logger.error({ err, paymentId }, "Could not check this payment's late captures for a lost record (#4149)");
    result.unresolved = true;
  }
  return result;
}
