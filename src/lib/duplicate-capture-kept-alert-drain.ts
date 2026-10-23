/**
 * #4285 review (`INV-PAY-043`): THE PAYMENTS CRON'S DRAIN for an owed
 * `new-capture` alert - a card capture kept on a PAID or COMPLETED booking
 * with no record of its settler and nothing else holding money.
 *
 * The settle records the alert as owed in the transaction that keeps the
 * capture (`recordNewCaptureAlertOwed`), and a delivered alert clears it
 * (`alertCaptureKeptWithoutRecordedSettler`). A crash between the commit and
 * the alert, or a send that throws, leaves the marker standing. The capture's
 * next arrival re-alerts while it stands, but a delivery the app already
 * answered 200 is never re-sent by Stripe, so this run is the trigger nothing
 * else guarantees. It goes through the same alert, so the once-a-day cooldown
 * still holds; a marker the cooldown blocks waits an hour before the next try.
 *
 * It re-judges what it says before sending (#4285 review). A capture that no
 * longer holds money (refunded since), or a booking gone, leaves nothing to
 * tell: its marker is cleared without an email. A booking cancelled or closed
 * since still holds the payment - a cancellation refunds at most what the
 * booking was worth - so it is told as `new-capture-closed`. Another payment
 * on the booking holding money now makes "nothing else holds money" untrue, so
 * it is told as the guard's `not-recorded` case, naming that payment. Any
 * delivered alert for the capture clears the marker.
 * Runs outside every transaction; never throws for one marker.
 */
import { PaymentTransactionKind } from "@prisma/client";
import { listOwedAlertKeys, noteOwedAlertAttempt, settleOwedAlert } from "@/lib/alert-cooldown";
import { bookingOwner } from "@/lib/booking-owner";
import { isPaidLikeBookingStatus } from "@/lib/booking-status";
import { clubFormatValues } from "@/lib/club-format-server";
import { alertCaptureKeptWithoutRecordedSettler, NEW_CAPTURE_ALERT_OWED_PREFIX } from "@/lib/duplicate-capture-guard";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";

/** How long a marker waits before the drain tries it: the post-commit alert goes first. */
export const NEW_CAPTURE_ALERT_DRAIN_AFTER_MS = 60 * 60 * 1000;

const CAPTURED = new Set<string>(CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST);

export async function drainOwedNewCaptureAlerts(now: Date = new Date()): Promise<{ checked: number; sent: number }> {
  const keys = await listOwedAlertKeys({ prefix: NEW_CAPTURE_ALERT_OWED_PREFIX, now, retryAfterMs: NEW_CAPTURE_ALERT_DRAIN_AFTER_MS });
  if (keys.length === 0) return { checked: 0, sent: 0 };
  const format = await clubFormatValues();
  let sent = 0;
  for (const key of keys) {
    const [bookingId, paymentIntentId] = key.slice(NEW_CAPTURE_ALERT_OWED_PREFIX.length).split(":") as [string, string];
    try {
      const [booking, capture] = await Promise.all([
        prisma.booking.findUnique({
          where: { id: bookingId },
          include: { member: true, organisation: { select: { name: true, email: true } } },
        }),
        prisma.paymentTransaction.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: { id: true, paymentId: true, status: true, amountCents: true },
        }),
      ]);
      if (!booking || !capture || !CAPTURED.has(capture.status)) {
        await settleOwedAlert({ key });
        continue;
      }
      // Another PRIMARY row on the payment holding money now, of any source.
      const other = await prisma.paymentTransaction.findFirst({
        where: {
          paymentId: capture.paymentId,
          id: { not: capture.id },
          kind: PaymentTransactionKind.PRIMARY,
          status: { in: [...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST] },
        },
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
        select: { stripePaymentIntentId: true },
      });
      const owner = bookingOwner(booking).member;
      const outcome = await alertCaptureKeptWithoutRecordedSettler({
        booking,
        memberName: `${owner.firstName} ${owner.lastName}`,
        paymentIntentId,
        amountCents: capture.amountCents,
        otherPaymentIntentId: other?.stripePaymentIntentId ?? null,
        otherHoldsMoney: !!other,
        reason: !isPaidLikeBookingStatus(booking.status) ? "new-capture-closed" : other ? "not-recorded" : "new-capture",
        format,
      });
      if (outcome === "sent") sent += 1;
      // Sent: the alert cleared the marker. Blocked by the day's cooldown: try
      // again later. A send that threw stays due for the next run.
      else if (outcome === "cooldown") await noteOwedAlertAttempt({ key, now });
    } catch (err) {
      logger.error({ err, key }, "Failed to deliver an owed new-capture alert (#4285)");
    }
  }
  return { checked: keys.length, sent };
}
