import { BookingStatus } from "@prisma/client";
import { isLateCaptureRefundedBookingStatus } from "@/lib/additional-payment-chase";
import { findHeldOnceEverAlertKeys, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { logAudit } from "@/lib/audit";
import { lateCaptureDoubleRefundAlertKey } from "@/lib/cancelled-booking-late-capture";
import { getClubFormat } from "@/lib/club-format-settings";
import { sendAdminLateCaptureRefundedOutsideAppAlert } from "@/lib/email";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import { findCapturesLandedAfterCancellation, readCaptureLandedAfterCancellation } from "@/lib/late-capture-landed-after";
import {
  findSupersededRefundOnlyIntents,
  parseAuditDetails,
  readMemberName,
  sentByLateCaptureRefundDoor,
} from "@/lib/late-capture-record-recovery";
import { findClosedLateCaptureRecords } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";

/**
 * #4149 / #4170 / #4173: the late captures whose refund has NO record yet, seen
 * from outside the lost-record recovery itself (`late-capture-record-recovery.ts`):
 *
 * - `readUnrecordedLateCaptureRefund`: what a `charge.refunded` on such a capture
 *   may do - never queue the payment's generic card note - and the alert for one
 *   refunded outside the app;
 * - `findPaymentsWithUnrecordedLateCaptures`: the nightly self-heal's own list of
 *   payments to run the recovery on, which does not depend on the refund-note gap.
 *
 * Split from the recovery for size; it calls into the recovery, never the reverse.
 */

/**
 * #4170: what a `charge.refunded` that raised a capture's refunded total, on a
 * capture with no late-capture record, must NOT do - queue the payment's
 * generic card note, which would credit the pre-cancel invoice for money Xero
 * never received. Asked by the webhook before that note:
 *
 * - `"awaiting_record"`: a refund in the charge carries this booking's
 *   late-capture door metadata, or the repair tool's
 *   (`LATE_CAPTURE_REPAIR_REFUND_METADATA_REASON`), so its writer - the delivery
 *   that refunded, Stripe's redelivery or the nightly self-heal, or the repair
 *   tool - writes the record and asks for the capture's own note.
 * - `"refunded_outside_the_app"`: no refund in the charge carries any of the
 *   app's own metadata for this booking, and the capture landed after the cancel
 *   (`readCaptureLandedAfterCancellation`: the primary handler's marker, or a
 *   cancel claim on the intent - so a dashboard refund made before the late
 *   success notice arrived counts too). No record can be proved for it, so it is
 *   the repair tool's case: an `important` entry names it, the officers are
 *   alerted once per capture, and the note-eligible cash leaves it out.
 * - `"none"`: an ordinary refund, or another door of the app's for this booking;
 *   the generic note goes ahead, capped by the note-eligible cash.
 *
 * A change payment captured after the cancel with no cancel claim on its intent
 * carries no evidence here and is not told apart: a stated limit.
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
      "A late-capture refund with no record yet: its record writes the capture's own note, not this generic one (#4170)",
    );
    return "awaiting_record";
  }
  if (params.refunds.some((refund) => refund.metadata?.bookingId === bookingId)) return "none";
  const capture = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { paymentId: true, reason: true },
  });
  if (capture?.paymentId !== paymentId) return "none";
  if (!(await readCaptureLandedAfterCancellation({ paymentIntentId, reason: capture.reason }))) return "none";
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
  await alertLateCaptureRefundedOutsideTheApp({ bookingId, paymentIntentId, refundedCents: params.refundedCents });
  return "refunded_outside_the_app";
}

/** The once-ever claim of a capture's refunded-outside-the-app alert (#4170). */
export function lateCaptureRefundedOutsideAppAlertKey(paymentIntentId: string): string {
  return `late-capture-refunded-outside-app:${paymentIntentId}`;
}

/**
 * Its alert: its own unmuteable template (`admin-late-capture-refunded-outside-app`,
 * `INV-ADDPAY-038`), once ever per capture. A send that throws gives the claim
 * back, and the nightly self-heal raises it again (`findPaymentsWithUnrecordedLateCaptures`).
 * Never throws.
 */
async function alertLateCaptureRefundedOutsideTheApp(alert: {
  bookingId: string;
  paymentIntentId: string;
  refundedCents: number;
}): Promise<boolean> {
  return sendAdminAlertOnceEver({
    key: lateCaptureRefundedOutsideAppAlertKey(alert.paymentIntentId),
    label: "late capture refunded outside the app alert",
    context: alert,
    send: async () => {
      const booking = await prisma.booking.findUnique({
        where: { id: alert.bookingId },
        select: {
          checkIn: true,
          checkOut: true,
          deletedAt: true,
          memberId: true,
          member: { select: { firstName: true, lastName: true } },
          organisation: { select: { name: true, email: true } },
        },
      });
      await sendAdminLateCaptureRefundedOutsideAppAlert(
        {
          memberName: readMemberName(booking),
          checkIn: booking?.checkIn ?? new Date(0),
          checkOut: booking?.checkOut ?? new Date(0),
          bookingId: alert.bookingId,
          paymentIntentId: alert.paymentIntentId,
          refundedCents: alert.refundedCents,
        },
        await getClubFormat(),
      );
      return UNMUTEABLE_ALERT_SENT;
    },
  });
}

/**
 * How far back the nightly list looks for a refunded late capture whose record
 * was lost. A record lost longer ago than this, whose redeliveries also never
 * arrived, is left to the repair tool: a stated limit.
 */
const LOST_RECORD_LOOKBACK_DAYS = 30;

/**
 * #4149: the nightly self-heal's OWN list of payments to check for a lost
 * record, which does not depend on the refund-note gap - a capture that landed
 * after the cancel is outside the note-eligible cash (#4170), so its payment
 * may never show a gap at all. Refunds recorded in the last
 * `LOST_RECORD_LOOKBACK_DAYS` on a cancelled booking, of a capture that landed
 * after the cancel (`findCapturesLandedAfterCancellation`) and has no closed
 * record (`findClosedLateCaptureRecords`). Change payments with no cancel claim
 * reach the recovery only through the gap list, as before.
 *
 * NOTHING THAT CANNOT RESOLVE IS LISTED, and that is decided before the cut to
 * `limit`, so a capture that never resolves cannot starve one that would:
 * - #4173: a capture whose recorded refunds the superseded-payment refund made
 *   (`findSupersededRefundOnlyIntents`) - no late-capture door sent them, so
 *   Stripe could never prove one, and its refund is already outside the
 *   note-eligible cash by its cancel claim;
 * - a hand-completed capture whose #2774 escalation is claimed (held);
 * - a capture named refunded outside the app
 *   (`booking.payment.late_capture_refunded_outside_app`): its alert is raised
 *   again here if its claim is not held (a send that threw), and it is not
 *   listed - no door refund will ever appear for it.
 */
export async function findPaymentsWithUnrecordedLateCaptures(now: Date, limit = 50): Promise<string[]> {
  const since = new Date(now.getTime() - LOST_RECORD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const refunds = await prisma.paymentRefund.findMany({
    where: {
      createdAt: { gte: since },
      stripePaymentIntentId: { not: null },
      // The population `isLateCaptureRefundedBookingStatus` names.
      payment: { booking: { status: BookingStatus.CANCELLED } },
    },
    orderBy: { createdAt: "asc" },
    select: { paymentId: true, stripePaymentIntentId: true, status: true, amountCents: true, payment: { select: { bookingId: true } } },
  });
  const byIntent = new Map<string, { paymentId: string; bookingId: string; refundedCents: number }>();
  for (const refund of refunds) {
    if (!refund.stripePaymentIntentId || !isRecordedRefundStatus(refund.status)) continue;
    const seen = byIntent.get(refund.stripePaymentIntentId);
    byIntent.set(refund.stripePaymentIntentId, {
      paymentId: refund.paymentId,
      bookingId: refund.payment.bookingId,
      refundedCents: (seen?.refundedCents ?? 0) + Math.max(0, refund.amountCents),
    });
  }
  if (byIntent.size === 0) return [];
  const closed = await findClosedLateCaptureRecords([...byIntent.keys()]);
  const open = [...byIntent.keys()].filter((intent) => closed.get(intent) !== "record");
  const landed = await findCapturesLandedAfterCancellation(open);
  const candidates = open.filter((intent) => landed.has(intent));
  const superseded = await findSupersededRefundOnlyIntents(
    new Map(candidates.map((intent) => [intent, byIntent.get(intent)!.refundedCents])),
  );
  const escalated = await findHeldOnceEverAlertKeys(
    candidates.filter((intent) => closed.get(intent) === "hand-completed").map(lateCaptureDoubleRefundAlertKey),
    now,
  );
  const outsideApp = await readRefundedOutsideAppIntents([...new Set(candidates.map((intent) => byIntent.get(intent)!.bookingId))]);
  for (const intent of candidates.filter((candidate) => outsideApp.has(candidate))) {
    const { bookingId, refundedCents } = byIntent.get(intent)!;
    await alertLateCaptureRefundedOutsideTheApp({ bookingId, paymentIntentId: intent, refundedCents });
  }
  const listed = candidates.filter(
    (intent) =>
      !superseded.has(intent) && !outsideApp.has(intent) && !escalated.has(lateCaptureDoubleRefundAlertKey(intent)),
  );
  return [...new Set(listed.map((intent) => byIntent.get(intent)!.paymentId))].slice(0, limit);
}

/** The intents these bookings' `late_capture_refunded_outside_app` entries name (#4170). */
async function readRefundedOutsideAppIntents(bookingIds: string[]): Promise<Set<string>> {
  if (bookingIds.length === 0) return new Set();
  const rows = await prisma.auditLog.findMany({
    where: { action: REFUNDED_OUTSIDE_APP_ACTION, entityId: { in: bookingIds } },
    select: { details: true },
  });
  const intents = new Set<string>();
  for (const row of rows ?? []) {
    const intent = parseAuditDetails(row.details)?.paymentIntentId;
    if (typeof intent === "string") intents.add(intent);
  }
  return intents;
}

const REFUNDED_OUTSIDE_APP_ACTION = "booking.payment.late_capture_refunded_outside_app";
