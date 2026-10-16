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
import { isLateCaptureHandlerWrite } from "@/lib/cancellation-settled-money";
import { lateCaptureAuditKind, queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { findClosedLateCaptureRecords } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { buildLateCaptureRefundMetadata } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { readRecordedRefundCentsByIntent } from "@/lib/refund-note-eligible-cash";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { isStripeResourceMissingError } from "@/lib/stripe-errors";

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
 *    (`findClosedLateCaptureRecords`: an `OPEN` #2700 row the refund never
 *    closed does not count) asks Stripe whether the late-capture refund door
 *    sent that refund (its own metadata, `buildLateCaptureRefundMetadata`) and,
 *    if it did, writes the missing row and its own
 *    `booking.payment.auto_refund_record_recovered` entry
 *    (`recoverLostLateCaptureRecord`). The alert is sent again unless the
 *    refund-time entry is one whose record write did NOT fail: an entry marked
 *    `recordLost` sat beside an alert that read its recipients from the database
 *    that had just failed, so it may never have gone, and #2761 prefers a
 *    duplicate to a silence. With no entry at all (the process died first) the
 *    recovery writes the entry as well;
 *  - a hand-COMPLETED #2700 row beside a door refund is #2774's residual double
 *    payment that the lost record hid: escalated once, as the record writer
 *    would have (`escalateHandCompletedDoorRefund`);
 *  - the nightly self-heal runs the same check before it raises any card note
 *    (`recoverLostLateCaptureRecordsForPayment`), so a capture whose
 *    redeliveries never arrive is recorded there and its refund leaves the
 *    note-eligible cash; one it cannot check is not noted that night, and an
 *    intent Stripe no longer knows holds no door refund rather than blocking
 *    the payment's note every night;
 *  - (#4170) a `charge.refunded` on such a capture queues no generic card note
 *    (`readUnrecordedLateCaptureRefund`), and the note-eligible cash leaves out
 *    a capture the primary handler marked as its own while it has no row.
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
 * stays the repair tool's - named by an entry for a primary capture, not told
 * apart for a change payment; and the refund of a superseded payment's intent
 * (#4173), which no late-capture door sends and this module does not recover.
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
  sendAutomaticLateCaptureAlert(capture, params.recordOutcome, params.format);
}

/** The one alert, fire-and-forget: webhooks stay non-blocking. */
function sendAutomaticLateCaptureAlert(
  capture: CancelledBookingLateCapture,
  recordOutcome: LateCaptureRecordOutcome,
  format: ClubFormat,
): void {
  announceAutomaticLateCaptureRefund(capture, recordOutcome, format).catch((err) =>
    logger.error(
      { err, bookingId: capture.bookingId, paymentIntentId: capture.paymentIntentId, captureKind: capture.captureKind },
      "Failed to send the late-capture cancellation alert",
    ),
  );
}

/**
 * The audit entries of one action on this booking that name this capture,
 * parsed: fetched by action and booking, and matched on the parsed
 * `paymentIntentId` in code - never a `LIKE` on the stored text (#4146).
 */
async function readCaptureEntries(
  action: string,
  bookingId: string,
  paymentIntentId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await prisma.auditLog.findMany({ where: { action, entityId: bookingId }, select: { details: true } });
  const entries: Record<string, unknown>[] = [];
  for (const row of rows ?? []) {
    try {
      const details = JSON.parse(row.details ?? "null") as unknown;
      if (details && typeof details === "object" && (details as { paymentIntentId?: unknown }).paymentIntentId === paymentIntentId) {
        entries.push(details as Record<string, unknown>);
      }
    } catch {
      // A truncated or foreign entry names no capture this can match.
    }
  }
  return entries;
}

/**
 * What the delivery that refunded this capture left in the audit log: `"none"`
 * (it died before its entry, so before its alert too), `"record_lost"` (its
 * entry says the record write failed - the alert was attempted, but against the
 * same database that had just failed, so it may not have gone), or
 * `"reported"` (an entry from a delivery whose record write did not fail; only
 * a release before #4149 leaves one without the row). Only `"reported"` lets the
 * recovery skip the alert: #2761 prefers a duplicate to a silence.
 */
async function readRefundTimeReport(
  bookingId: string,
  paymentIntentId: string,
): Promise<"none" | "record_lost" | "reported"> {
  const entries = await readCaptureEntries("booking.payment.refunded_after_cancellation", bookingId, paymentIntentId);
  if (entries.some((entry) => entry.recordLost !== true && entry.recoveredLostRecord !== true)) return "reported";
  return entries.length > 0 ? "record_lost" : "none";
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
  const closed = (await findClosedLateCaptureRecords([paymentIntentId])).get(paymentIntentId);
  if (closed === "record") return false;
  if (closed === "hand-completed" && (await readCaptureEntries(DOUBLE_REFUND_ACTION, bookingId, paymentIntentId)).length > 0) {
    return false;
  }
  const sent = await listDoorRefunds(bookingId, paymentIntentId, options.stripeTimeoutMs ?? REDELIVERY_STRIPE_TIMEOUT_MS);
  const [first] = sent;
  if (!first) return false;
  const capture = describeLateCaptureFromBooking(booking, identity);
  if (closed === "hand-completed") {
    await escalateHandCompletedDoorRefund(capture, options.format);
    return false;
  }

  const refundTimeReport = await readRefundTimeReport(bookingId, paymentIntentId);
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
  const alertSent = refundTimeReport !== "reported";
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
      refundTimeReport,
      alertSent,
    }),
  });
  if (refundTimeReport === "none") {
    // The delivery that refunded died before its entry and alert: neither went out, so both go now.
    reportAutomaticLateCaptureRefund({
      capture,
      format: options.format,
      recordOutcome,
      refundId: first.id,
      auditDetail: { refundedCents, recoveredLostRecord: true },
    });
  } else if (alertSent) {
    // Its entry is there, but the alert beside it may have failed with the record write: sent again (#2761).
    sendAutomaticLateCaptureAlert(capture, recordOutcome, options.format);
  }
  logger.warn(
    { bookingId, paymentId: capture.paymentId, paymentIntentId, refundTimeReport, alertSent },
    "Wrote the lost record of an automatic late-capture refund (#4149)",
  );
  await queueLateCaptureRefundCreditNote({ paymentId: capture.paymentId, paymentIntentId });
  return true;
}

const DOUBLE_REFUND_ACTION = "booking.payment.late_capture_double_refund_suspected";

/**
 * The refunds of this capture the late-capture door sent for this booking,
 * oldest first. An intent Stripe no longer knows (`resource_missing`: an old or
 * test-mode intent) holds none, rather than failing every check of it for ever
 * and so holding the payment's card note back every night.
 */
async function listDoorRefunds(bookingId: string, paymentIntentId: string, timeoutMs: number) {
  let refunds: Awaited<ReturnType<typeof listRefundsForPaymentIntent>>;
  try {
    refunds = await listRefundsForPaymentIntent(paymentIntentId, { timeoutMs });
  } catch (err) {
    if (!isStripeResourceMissingError(err)) throw err;
    logger.warn({ bookingId, paymentIntentId }, "Stripe no longer knows this late capture's intent; no refund of it is the late-capture door's (#4149)");
    return [];
  }
  return refunds
    .filter((refund) => sentByLateCaptureRefundDoor(refund.metadata, bookingId) && !isRefusedRefundStatus(refund.status))
    .sort((a, b) => a.created - b.created);
}

/**
 * #2774's residual double payment, found late: an operator hand-COMPLETED the
 * #2700 task while the record of the door's refund was lost, so the record
 * writer never saw the completion after the refund and nothing escalated. The
 * same escalation the record writer raises - the `critical` entry and the
 * conflict alert (`announceAutomaticLateCaptureRefund`) - once: the caller
 * checks for its entry first.
 */
async function escalateHandCompletedDoorRefund(capture: CancelledBookingLateCapture, format: ClubFormat): Promise<void> {
  await announceAutomaticLateCaptureRefund(
    capture,
    {
      bookingDeleted: capture.openingDeletedAt !== null,
      recorded: true,
      alreadyRecorded: "hand-resolved",
      handCompletedAfterRefund: true,
    },
    format,
  ).catch((err) =>
    logger.error(
      { err, bookingId: capture.bookingId, paymentIntentId: capture.paymentIntentId },
      "Failed to escalate a late capture hand-completed beside the late-capture door's refund (#4149)",
    ),
  );
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
    const closed = await findClosedLateCaptureRecords(intents);
    let format: ClubFormat | null = null;
    for (const paymentIntentId of intents.filter((intent) => closed.get(intent) !== "record")) {
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

/**
 * #4170: what a `charge.refunded` that raised a capture's refunded total, on a
 * capture with no late-capture record, must NOT do - queue the payment's
 * generic card note, which would credit the pre-cancel invoice for money Xero
 * never received. Asked by the webhook before that note:
 *
 * - `"awaiting_record"`: a refund in the charge carries this booking's
 *   late-capture door metadata, so the delivery that refunded (or, if it died,
 *   Stripe's redelivery or the nightly self-heal) writes the record and asks for
 *   the capture's own note. Nothing is noted here.
 * - `"refunded_outside_the_app"`: no door refund, but the primary late-capture
 *   handler marked the capture as its own - refunded some other way (the Stripe
 *   dashboard). No record can be proved for it, so it is the repair tool's case:
 *   an `important` entry names it, and the note-eligible cash already leaves it
 *   out (`resolveRefundNoteEligibleCash`).
 * - `"none"`: an ordinary refund; the generic note goes ahead.
 *
 * A change payment refunded outside the app carries no marker and is not told
 * apart here: a stated limit.
 */
export async function readUnrecordedLateCaptureRefund(params: {
  paymentId: string;
  paymentIntentId: string;
  refundedCents: number;
  refunds: ReadonlyArray<{ id?: string; metadata?: Record<string, string> | null }>;
}): Promise<"none" | "awaiting_record" | "refunded_outside_the_app"> {
  const { paymentId, paymentIntentId } = params;
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { bookingId: true, booking: { select: { status: true } } },
  });
  if (!payment || !isLateCaptureRefundedBookingStatus(payment.booking?.status)) return "none";
  const { bookingId } = payment;
  if (params.refunds.some((refund) => sentByLateCaptureRefundDoor(refund.metadata, bookingId))) {
    logger.info(
      { bookingId, paymentId, paymentIntentId },
      "A late-capture door refund with no record yet: its record writes the capture's own note, not this generic one (#4170)",
    );
    return "awaiting_record";
  }
  const capture = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { paymentId: true, reason: true },
  });
  if (capture?.paymentId !== paymentId || !isLateCaptureHandlerWrite(capture.reason)) return "none";
  logAudit({
    action: "booking.payment.late_capture_refunded_outside_app",
    category: "payment",
    severity: "important",
    entityType: "Booking",
    entityId: bookingId,
    targetId: bookingId,
    details: JSON.stringify({
      paymentIntentId,
      refundIds: params.refunds.map((refund) => refund.id ?? null),
      refundedCents: params.refundedCents,
      creditNoteQueued: false,
    }),
  });
  logger.error(
    { bookingId, paymentId, paymentIntentId, refundedCents: params.refundedCents },
    "A late capture was refunded outside the app's late-capture refund: no record or Xero note is written for it; the repair tool's case (#4170)",
  );
  return "refunded_outside_the_app";
}
