import { PaymentRecoveryOperationType, PaymentTransactionKind } from "@prisma/client";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { findHeldOnceEverAlertKeys } from "@/lib/admin-alert-once";
import { logAudit } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import {
  announceAutomaticLateCaptureRefund,
  lateCaptureDoubleRefundAlertKey,
  recordAutomaticLateCaptureRefund,
  type CancelledBookingLateCapture,
  type LateCaptureRecordOutcome,
} from "@/lib/cancelled-booking-late-capture";
import type { ClubFormat } from "@/lib/club-format";
import { getClubFormat } from "@/lib/club-format-settings";
import { readCaptureLandedAfterCancellation } from "@/lib/late-capture-landed-after";
import { lateCaptureAuditKind, queueLateCaptureRefundCreditNote } from "@/lib/late-capture-refund-credit-note";
import { findClosedLateCaptureRecords } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { buildLateCaptureRefundMetadata, LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON } from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { readRecordedRefundCentsByIntent } from "@/lib/refund-note-eligible-cash";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { isStripeResourceAbsentHere } from "@/lib/stripe-errors";

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
 *    payment that the lost record hid: escalated through the record writer's
 *    own escalation, which is claimed once ever per capture
 *    (`lateCaptureDoubleRefundAlertKey`) - the claim, not the entry, is the gate;
 *  - a refund the repair tool made carries its own late-capture metadata
 *    (`LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON`) and is a door refund too;
 *  - the nightly self-heal runs the same check (`recoverLostLateCaptureRecordsForPayment`)
 *    over its OWN list (`findPaymentsWithUnrecordedLateCaptures`,
 *    `late-capture-unrecorded-refunds.ts`), which does
 *    not depend on the refund-note gap, and again before it raises any card
 *    note, so a capture whose redeliveries never arrive is recorded there; one
 *    it cannot check is not noted that night, and an intent this Stripe account
 *    and mode no longer knows holds no door refund rather than blocking the
 *    payment's note every night;
 *  - (#4170) a `charge.refunded` on such a capture queues no generic card note
 *    (`readUnrecordedLateCaptureRefund`), and the note-eligible cash leaves out,
 *    on a cancelled booking, a capture that landed after the cancel while it has
 *    no row (`late-capture-landed-after.ts`); one refunded outside the app is
 *    named and alerted through its own unmuteable template;
 *  - (#4173) a capture the superseded-payment refund refunded, on a cancelled
 *    booking, is outside the note-eligible cash by its cancel claim, and is
 *    never asked of Stripe (`findSupersededRefundOnlyIntents`): no late-capture
 *    door sent it, so no record can be proved for it.
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
 * stays the repair tool's - named and alerted when the capture landed after the
 * cancel, not told apart for a change payment with no cancel claim; a lost
 * record older than the nightly list's 30 days whose redeliveries never came;
 * and whether the superseded-intent hand-off and the booking's settlement are
 * serialised against each other, which this change did not check: #4173's
 * exclusion reads the superseded refund's own recovery row and the cancel claim,
 * not their ordering.
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
    const details = parseAuditDetails(row.details);
    if (details?.paymentIntentId === paymentIntentId) entries.push(details);
  }
  return entries;
}

/** An entry's `details` as an object, or null: a truncated or foreign entry names no capture. */
export function parseAuditDetails(details: string | null): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(details ?? "null") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
 * A Stripe refund one of this booking's late-capture refund doors sent: its
 * metadata is exactly the body `buildLateCaptureRefundMetadata` builds, which
 * the webhook's automatic refund and the treasurer-approved one both send
 * (`INV-PAY-106`), or the repair tool's (`LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON`),
 * whose record is the same row (`recordAndNoteRepairedLateCaptureRefunds`).
 */
export function sentByLateCaptureRefundDoor(metadata: Record<string, string> | null | undefined, bookingId: string): boolean {
  const sent = buildLateCaptureRefundMetadata(bookingId);
  if (!metadata || metadata.bookingId !== sent.bookingId) return false;
  return metadata.reason === sent.reason || metadata.reason === LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON;
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
  // #2774's escalation is claimed once ever (`lateCaptureDoubleRefundAlertKey`):
  // a capture whose claim is held - raised at refund time or by an earlier check -
  // is asked nothing more; one given back after a failed send is raised again.
  if (closed === "hand-completed" && (await isDoubleRefundEscalationHeld(paymentIntentId))) return false;
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

async function isDoubleRefundEscalationHeld(paymentIntentId: string): Promise<boolean> {
  const key = lateCaptureDoubleRefundAlertKey(paymentIntentId);
  return (await findHeldOnceEverAlertKeys([key], new Date())).has(key);
}

/**
 * The refunds of this capture the late-capture door sent for this booking,
 * oldest first. An intent this Stripe account and mode no longer knows
 * (`resource_missing`: an old or deleted intent) holds none, rather than failing
 * every check of it for ever and so holding the payment's card note back every
 * night. One Stripe says exists in the other mode or on another account is a
 * configuration fault, not an absence, so it still throws: unresolved
 * (`isStripeResourceAbsentHere`).
 */
async function listDoorRefunds(bookingId: string, paymentIntentId: string, timeoutMs: number) {
  let refunds: Awaited<ReturnType<typeof listRefundsForPaymentIntent>>;
  try {
    refunds = await listRefundsForPaymentIntent(paymentIntentId, { timeoutMs });
  } catch (err) {
    if (!isStripeResourceAbsentHere(err)) throw err;
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
 * record writer's own escalation (`announceAutomaticLateCaptureRefund`: the
 * `critical` entry and the conflict alert), which claims it once ever per
 * capture, so racing checks and the refund-time writer raise it once between
 * them; the claim, not the entry, is the gate.
 */
async function escalateHandCompletedDoorRefund(capture: CancelledBookingLateCapture, format: ClubFormat): Promise<void> {
  await announceAutomaticLateCaptureRefund(
    capture,
    { bookingDeleted: capture.openingDeletedAt !== null, recorded: true, alreadyRecorded: "hand-resolved", handCompletedAfterRefund: true },
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

export function readMemberName(booking: LateCaptureRecordBooking | null): string {
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
    const centsByIntent = await readRecordedRefundCentsByIntent(paymentId);
    const intents = [...centsByIntent.keys()];
    if (intents.length === 0) return result;
    const closed = await findClosedLateCaptureRecords(intents);
    // #4173: a superseded-payment refund can never be proved a late-capture door's.
    const superseded = await findSupersededRefundOnlyIntents(centsByIntent);
    let format: ClubFormat | null = null;
    for (const paymentIntentId of intents.filter((intent) => closed.get(intent) !== "record" && !superseded.has(intent))) {
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
 * #4173: the intents among these whose recorded refunds the superseded-payment
 * refund made - a `REFUND_SUPERSEDED_PAYMENT` recovery for the intent whose
 * amounts cover every recorded cent. That door writes no late-capture record and
 * sends no late-capture metadata, so the lost-record recovery can never prove
 * one for it; and its cancel claim already keeps its refund out of the
 * note-eligible cash on a cancelled booking (`late-capture-landed-after.ts`).
 */
export async function findSupersededRefundOnlyIntents(refundedCentsByIntent: Map<string, number>): Promise<Set<string>> {
  if (refundedCentsByIntent.size === 0) return new Set();
  const operations = await prisma.paymentRecoveryOperation.findMany({
    where: { type: PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT, paymentIntentId: { in: [...refundedCentsByIntent.keys()] } },
    select: { paymentIntentId: true, amountCents: true },
  });
  const coveredCents = new Map<string, number>();
  for (const operation of operations) {
    coveredCents.set(operation.paymentIntentId, (coveredCents.get(operation.paymentIntentId) ?? 0) + operation.amountCents);
  }
  return new Set(
    [...refundedCentsByIntent].filter(([intent, cents]) => cents <= (coveredCents.get(intent) ?? 0)).map(([intent]) => intent),
  );
}
