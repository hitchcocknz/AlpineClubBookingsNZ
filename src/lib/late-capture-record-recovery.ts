import { PaymentTransactionKind } from "@prisma/client";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { logAudit } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  announceAutomaticLateCaptureRefund,
  readCaptureLandedAfterCancellation,
  recordAutomaticLateCaptureRefund,
  type CancelledBookingLateCapture,
  type LateCaptureRecordOutcome,
} from "@/lib/cancelled-booking-late-capture";
import type { ClubFormat } from "@/lib/club-format";
import { getClubFormat } from "@/lib/club-format-settings";
import { lateCaptureAuditKind, queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { findClosedLateCaptureRecordIntents } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { buildLateCaptureRefundMetadata } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { readRecordedRefundCentsByIntent } from "@/lib/refund-note-eligible-cash";
import { listRefundsForPaymentIntent } from "@/lib/stripe";

/**
 * #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): THE RECORD OF AN AUTOMATIC
 * LATE-CAPTURE REFUND IS WRITTEN ONCE, EVEN WHEN THE DELIVERY THAT REFUNDED DIES.
 *
 * Both late-capture handlers refund at Stripe and then finish with
 * `finishAutomaticLateCaptureRefund`: the record row (the already-`DISMISSED`
 * task, `recordAutomaticLateCaptureRefund`), the
 * `booking.payment.refunded_after_cancellation` entry, the one alert and the
 * per-capture Xero note.
 *
 * Before #4149, a process that died, or a record write that failed, after the
 * refund was made and recorded left NO record row for good: a redelivery found
 * the capture refunded and acknowledged it (`acknowledgeSettledLateNotice`), and
 * with no row the intent was not a known late capture
 * (`findLateCapturePaymentIntents`), so the nightly self-heal counted its refund
 * as note-eligible cash and raised a whole-capture card note against the
 * pre-cancel invoice - an over-note for money Xero never received.
 *
 * Now:
 *  - the delivery that refunded ALWAYS writes the entry and sends the alert,
 *    as before, and a lost record write marks the entry `recordLost: true` and
 *    then answers 500 (`LateCaptureRecordLostError`), so Stripe redelivers. Since
 *    #3639 a replay after a refund never refunds again;
 *  - a redelivery that finds the capture refunded with no closed record row
 *    (`findClosedLateCaptureRecordIntents`: an `OPEN` #2700 row the refund never
 *    closed does not count) asks Stripe whether the late-capture refund door
 *    sent that refund (its own metadata, `buildLateCaptureRefundMetadata`) and,
 *    if it did, writes the missing row and its own
 *    `booking.payment.auto_refund_record_recovered` entry
 *    (`recoverLostLateCaptureRecord`). It sends no second alert: the refund-time
 *    entry says the alert went out. Only when there is no such entry - the
 *    process died before it - does the recovery write it and send the alert,
 *    because the event must never get neither;
 *  - the nightly self-heal runs the same check before it raises any card note
 *    (`recoverLostLateCaptureRecordsForPayment`), so a capture whose
 *    redeliveries never arrive is recorded there and its refund leaves the
 *    note-eligible cash; one it cannot check is not noted that night.
 *
 * EXACTLY ONCE. The record row is the claim: `recordAutomaticCancelledBookingRefundTask`
 * closes or creates it under `pg_advisory_xact_lock(1)` and answers a later
 * writer `alreadyRecorded`, and only the recovery that wrote the row writes the
 * recovered entry (and, after a crash, the refund entry and the alert). So two
 * redeliveries, a redelivery racing the self-heal, and a retried lost write
 * give one row. The note is sized against the notes already raised for the
 * capture (`noteLateCaptureRefunds`), so every writer may ask for it.
 *
 * Not covered, and stated: a process that dies between the row's commit and
 * the entry and alert (no awaited call sits between them); a capture whose
 * refund door left no metadata of its own (a Stripe dashboard refund), which
 * stays the repair tool's; and the refund of a superseded payment's intent
 * (#4173), which no late-capture door sends and this module does not recover.
 * An alert whose refund-time entry could not be written is sent again by the
 * recovery: a duplicate, never a silence (#2761).
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
 * handlers: the record (awaited), then the `refunded_after_cancellation` entry
 * and the alert (fire-and-forget - webhooks stay non-blocking) from the delivery
 * that refunded, whatever the record write found (`INV-ADDPAY-037`: never
 * neither). A lost record write marks the entry `recordLost: true` and throws
 * `LateCaptureRecordLostError` before the Xero note, which the recovery asks for
 * once it has written the row. `auditDetail` carries what a handler adds to the
 * shared fields.
 */
export async function finishAutomaticLateCaptureRefund(params: {
  capture: CancelledBookingLateCapture;
  format: ClubFormat;
  refundId: string | null;
  auditDetail?: Record<string, unknown>;
}): Promise<void> {
  const { capture, format } = params;
  const recordOutcome = await recordAutomaticLateCaptureRefund(capture);
  reportAutomaticLateCaptureRefund({
    capture,
    format,
    recordOutcome,
    refundId: params.refundId,
    auditDetail: recordOutcome.recorded ? params.auditDetail : { ...params.auditDetail, recordLost: true },
  });
  // Its own `critical` audit row is written; the 500 brings the redelivery that writes the record.
  if (!recordOutcome.recorded) throw new LateCaptureRecordLostError(capture);

  // The corrective Xero credit note, when there is anything to correct (#3635).
  await queueLateCaptureRefundCreditNote({
    paymentId: capture.paymentId,
    paymentIntentId: capture.paymentIntentId,
  });
}

/**
 * The `booking.payment.refunded_after_cancellation` entry and the one alert
 * (#2761 / #2773: the unmuteable notification for the event, `INV-ADDPAY-037`),
 * written together, by the delivery that refunded or, after a crash took both,
 * by the recovery.
 */
function reportAutomaticLateCaptureRefund(params: {
  capture: CancelledBookingLateCapture;
  format: ClubFormat;
  recordOutcome: LateCaptureRecordOutcome;
  refundId: string | null;
  auditDetail?: Record<string, unknown>;
}): void {
  const { capture } = params;
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
  announceAutomaticLateCaptureRefund(capture, params.recordOutcome, params.format).catch((err) =>
    logger.error(
      { err, bookingId: capture.bookingId, paymentIntentId: capture.paymentIntentId, captureKind: capture.captureKind },
      "Failed to send the late-capture cancellation alert",
    ),
  );
}

/**
 * Whether the delivery that refunded this capture wrote its
 * `refunded_after_cancellation` entry - and so sent the alert beside it. Matched
 * on the booking and the intent the entry names; an entry written before #4149
 * counts the same, because that release sent the alert with it too.
 */
async function wasReportedAtRefund(bookingId: string, paymentIntentId: string): Promise<boolean> {
  const entry = await prisma.auditLog.findFirst({
    where: {
      action: "booking.payment.refunded_after_cancellation",
      entityId: bookingId,
      details: { contains: paymentIntentId },
    },
    select: { id: true },
  });
  return entry !== null;
}

/**
 * A Stripe refund this booking's late-capture refund door sent: its metadata is
 * exactly the body `buildLateCaptureRefundMetadata` builds, which the webhook's
 * automatic refund and the treasurer-approved one both send (`INV-PAY-106`).
 */
function sentByLateCaptureRefundDoor(metadata: Record<string, string> | null | undefined, bookingId: string): boolean {
  const sent = buildLateCaptureRefundMetadata(bookingId);
  return metadata?.reason === sent.reason && metadata?.bookingId === sent.bookingId;
}

/** A webhook's Stripe read is bounded and never retried: Stripe's own delivery timeout is over it. */
const REDELIVERY_STRIPE_TIMEOUT_MS = 5_000;
/** A nightly sweep's Stripe read is bounded, as the payments cron's are (#3641). */
const SELF_HEAL_STRIPE_TIMEOUT_MS = 10_000;

/** What the record and its alert name about one capture, before its booking row is read. */
export type LateCaptureIdentity = {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  transactionKind: PaymentTransactionKind | null;
};

/**
 * The redelivery's half: `true` when this already-refunded capture had lost its
 * record and this call has now written it; `false` when it has a closed record
 * (its own row, an operator's, or #3639's approval task), when Stripe holds no
 * refund the late-capture door sent for this booking, or when another writer
 * recorded it first. Nothing is caught: a read or a record write that cannot
 * answer leaves the webhook to answer 500 and Stripe to redeliver, rather than
 * acknowledging a capture whose record is lost. The capture is described from
 * its booking only once both checks have passed.
 */
export async function recoverLostLateCaptureRecord(
  booking: LateCaptureRecordBooking | null,
  identity: LateCaptureIdentity,
  options: { format: ClubFormat; stripeTimeoutMs?: number },
): Promise<boolean> {
  const { bookingId, paymentIntentId } = identity;
  if ((await findClosedLateCaptureRecordIntents([paymentIntentId])).has(paymentIntentId)) return false;
  const sent = (
    await listRefundsForPaymentIntent(paymentIntentId, {
      timeoutMs: options.stripeTimeoutMs ?? REDELIVERY_STRIPE_TIMEOUT_MS,
    })
  )
    .filter((refund) => sentByLateCaptureRefundDoor(refund.metadata, bookingId) && !isRefusedRefundStatus(refund.status))
    .sort((a, b) => a.created - b.created);
  const [first] = sent;
  if (!first) return false;

  const reportedAtRefund = await wasReportedAtRefund(bookingId, paymentIntentId);
  const capture = describeLateCaptureFromBooking(booking, identity);
  // Dated the refund's day, as the card shows it (`docs/guides/payments.md`).
  const recordOutcome = await recordAutomaticLateCaptureRefund(capture, { completedAt: new Date(first.created * 1000) });
  if (!recordOutcome.recorded) throw new LateCaptureRecordLostError(capture);
  if (recordOutcome.alreadyRecorded !== false) {
    logger.info(
      { bookingId, paymentIntentId, alreadyRecorded: recordOutcome.alreadyRecorded },
      "Another writer recorded this automatic late-capture refund first; nothing was recovered (#4149)",
    );
    return false;
  }

  const refundedCents = sent.reduce((sum, refund) => sum + refund.amount, 0);
  logAudit({
    action: "booking.payment.auto_refund_record_recovered",
    category: "payment",
    entityType: "Booking",
    entityId: bookingId,
    targetId: bookingId,
    details: JSON.stringify({
      paymentIntentId,
      refundId: first.id,
      amountCents: capture.amountCents,
      refundedCents,
      kind: lateCaptureAuditKind(capture.captureKind),
      reportedAtRefund,
    }),
  });
  // The delivery that refunded died before its entry and alert: neither went out, so they go now.
  if (!reportedAtRefund) {
    reportAutomaticLateCaptureRefund({
      capture,
      format: options.format,
      recordOutcome,
      refundId: first.id,
      auditDetail: { refundedCents, recoveredLostRecord: true },
    });
  }
  logger.warn(
    { bookingId, paymentId: capture.paymentId, paymentIntentId, reportedAtRefund },
    "Wrote the lost record of an automatic late-capture refund (#4149)",
  );
  await queueLateCaptureRefundCreditNote({ paymentId: capture.paymentId, paymentIntentId });
  return true;
}

/** The booking fields a late capture's record and alert name. */
export type LateCaptureRecordBooking = {
  checkIn: Date;
  checkOut: Date;
  deletedAt: Date | null;
  memberId?: string | null;
  member: { firstName: string; lastName: string } | null;
  organisation: { name: string; email: string | null } | null;
};

/**
 * One late capture, described from its booking row - for both webhook handlers,
 * the recovery and the repair tool. An owner that cannot be read names an
 * "unknown member" rather than failing the caller.
 */
export function describeLateCaptureFromBooking(
  booking: LateCaptureRecordBooking | null,
  capture: LateCaptureIdentity,
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

/**
 * The nightly self-heal's half (`reconcileCreditBalances`), asked before it
 * queues any refund note for a payment: the payment's refunded captures on a
 * cancelled booking with no closed record are checked as a redelivery checks
 * them - a change payment's always (its handler stamps no late marker, so the
 * cancel may have left no evidence it landed after), the booking's own payment
 * when it landed after the cancel (`readCaptureLandedAfterCancellation`).
 * `recovered` had lost their record and have it now, so their refunds leave the
 * note-eligible cash; `unresolved` says one could not be checked (Stripe or the
 * record write failed, logged), and the caller raises no note for the payment
 * that night. Never throws.
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
    const booking = payment?.booking;
    if (!payment || !booking || !isLateCaptureRefundedBookingStatus(booking.status)) return result;
    const intents = [...(await readRecordedRefundCentsByIntent(paymentId)).keys()];
    if (intents.length === 0) return result;
    const recorded = await findClosedLateCaptureRecordIntents(intents);
    let format: ClubFormat | null = null;
    for (const paymentIntentId of intents.filter((intent) => !recorded.has(intent))) {
      try {
        const capture = await prisma.paymentTransaction.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: { paymentId: true, kind: true, amountCents: true, reason: true },
        });
        if (!capture || capture.paymentId !== paymentId) continue;
        const mayBeLateCapture =
          capture.kind === PaymentTransactionKind.ADDITIONAL ||
          (await readCaptureLandedAfterCancellation({ paymentIntentId, reason: capture.reason }));
        if (!mayBeLateCapture) continue;
        format ??= await getClubFormat();
        const recovered = await recoverLostLateCaptureRecord(
          booking,
          {
            bookingId: payment.bookingId,
            paymentId,
            paymentIntentId,
            amountCents: capture.amountCents,
            transactionKind: capture.kind,
          },
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
