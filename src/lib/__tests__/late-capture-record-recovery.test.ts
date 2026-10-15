import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): a late capture's automatic refund is
 * recorded exactly once, even when the delivery that refunded it dies before
 * its record.
 *
 * The webhook route end to end, killed between the refund and the record and
 * then redelivered, is in `stripe-webhook-alerts.test.ts`; the record row's
 * exactly-once claim under `pg_advisory_xact_lock(1)`, raced for real, is in
 * `late-capture-record-recovery.realdb.test.ts`. This file pins the module's own
 * decisions: what the epilogue writes on each record outcome, what proves a
 * refund was the late-capture door's, and what the nightly self-heal checks.
 */

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  announce: vi.fn(),
  landedAfter: vi.fn(),
  queueNote: vi.fn(),
  findLate: vi.fn(),
  listRefunds: vi.fn(),
  logAudit: vi.fn(),
  getClubFormat: vi.fn(),
  paymentFindUnique: vi.fn(),
  paymentRefundFindMany: vi.fn(),
  paymentTransactionFindUnique: vi.fn(),
}));

vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  recordAutomaticLateCaptureRefund: (...args: unknown[]) => mocks.record(...args),
  announceAutomaticLateCaptureRefund: (...args: unknown[]) => mocks.announce(...args),
  readCaptureLandedAfterCancellation: (...args: unknown[]) => mocks.landedAfter(...args),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  queueLateCaptureRefundCreditNote: (...args: unknown[]) => mocks.queueNote(...args),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findLateCapturePaymentIntents: (...args: unknown[]) => mocks.findLate(...args),
}));
vi.mock("@/lib/stripe", () => ({
  listRefundsForPaymentIntent: (...args: unknown[]) => mocks.listRefunds(...args),
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/club-format-settings", () => ({ getClubFormat: () => mocks.getClubFormat() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findUnique: (...args: unknown[]) => mocks.paymentFindUnique(...args) },
    paymentRefund: { findMany: (...args: unknown[]) => mocks.paymentRefundFindMany(...args) },
    paymentTransaction: { findUnique: (...args: unknown[]) => mocks.paymentTransactionFindUnique(...args) },
  },
}));

import {
  LateCaptureRecordLostError,
  finishAutomaticLateCaptureRefund,
  recoverLostLateCaptureRecord,
  recoverLostLateCaptureRecordsForPayment,
} from "@/lib/late-capture-record-recovery";
import type { CancelledBookingLateCapture } from "@/lib/cancelled-booking-late-capture";
import { buildLateCaptureRefundMetadata } from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const INTENT = "pi_late";

function capture(overrides: Partial<CancelledBookingLateCapture> = {}): CancelledBookingLateCapture {
  return {
    bookingId: "booking-1",
    paymentId: "payment-1",
    paymentIntentId: INTENT,
    amountCents: 2500,
    memberName: "Alice Example",
    checkIn: new Date("2026-08-01"),
    checkOut: new Date("2026-08-03"),
    openingDeletedAt: null,
    captureKind: "primary",
    ...overrides,
  };
}

const RECORDED = { bookingDeleted: false, recorded: true, recordedBefore: false, handCompletedAfterRefund: false };
/** A refund as Stripe lists it, sent by the late-capture door for booking-1 unless told otherwise. */
const stripeRefund = (overrides: Record<string, unknown> = {}) => ({
  id: "re_late_1",
  amount: 2500,
  status: "succeeded",
  metadata: buildLateCaptureRefundMetadata("booking-1"),
  ...overrides,
});
const refundEntries = () =>
  mocks.logAudit.mock.calls
    .map(([entry]) => entry as { action: string; details: string })
    .filter((entry) => entry.action === "booking.payment.refunded_after_cancellation");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockResolvedValue(RECORDED);
  mocks.announce.mockResolvedValue(undefined);
  mocks.queueNote.mockResolvedValue(undefined);
  mocks.findLate.mockResolvedValue(new Set());
  mocks.listRefunds.mockResolvedValue([stripeRefund()]);
  mocks.landedAfter.mockResolvedValue(true);
  mocks.getClubFormat.mockResolvedValue(CLUB_FORMAT_TEST);
});

describe("finishAutomaticLateCaptureRefund — the one epilogue", () => {
  it("writes the record, then the refund entry, the alert and the note", async () => {
    await finishAutomaticLateCaptureRefund({
      capture: capture({ captureKind: "modification" }),
      format: CLUB_FORMAT_TEST,
      refundId: "re_late_1",
      auditDetail: { extra: 1 },
    });

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(refundEntries()).toHaveLength(1);
    expect(JSON.parse(refundEntries()[0]!.details)).toEqual({
      paymentIntentId: INTENT,
      refundId: "re_late_1",
      amountCents: 2500,
      kind: "modification_additional",
      extra: 1,
    });
    expect(mocks.announce).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: INTENT }), RECORDED, CLUB_FORMAT_TEST);
    expect(mocks.queueNote).toHaveBeenCalledWith({ paymentId: "payment-1", paymentIntentId: INTENT });
  });

  it("throws on a lost record write — the webhook answers 500 and the redelivery writes it — with no entry, alert or note yet", async () => {
    mocks.record.mockResolvedValueOnce({ ...RECORDED, recorded: false });

    await expect(
      finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: "re_late_1" }),
    ).rejects.toBeInstanceOf(LateCaptureRecordLostError);
    expect(refundEntries()).toHaveLength(0);
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.queueNote).not.toHaveBeenCalled();
  });

  it("writes no second entry or alert when another delivery's row was already there, and still asks for the note", async () => {
    mocks.record.mockResolvedValueOnce({ ...RECORDED, recordedBefore: true });

    await finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: "re_late_1" });

    expect(refundEntries()).toHaveLength(0);
    expect(mocks.announce).not.toHaveBeenCalled();
    // Sized against the notes already raised for the capture, so asking again is safe.
    expect(mocks.queueNote).toHaveBeenCalledTimes(1);
  });

  it("never lets the alert's failure fail the epilogue", async () => {
    mocks.announce.mockRejectedValueOnce(new Error("mail provider down"));
    await expect(
      finishAutomaticLateCaptureRefund({ capture: capture(), format: CLUB_FORMAT_TEST, refundId: null }),
    ).resolves.toBeUndefined();
    expect(mocks.queueNote).toHaveBeenCalledTimes(1);
  });
});

describe("recoverLostLateCaptureRecord — a redelivery's check", () => {
  it("writes the lost record when Stripe holds a refund the late-capture door sent for this booking", async () => {
    mocks.listRefunds.mockResolvedValueOnce([stripeRefund(), stripeRefund({ id: "re_late_2", amount: 500 })]);

    await expect(recoverLostLateCaptureRecord(capture(), { format: CLUB_FORMAT_TEST })).resolves.toBe(true);

    expect(mocks.listRefunds).toHaveBeenCalledWith(INTENT, undefined);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(JSON.parse(refundEntries()[0]!.details)).toMatchObject({
      refundId: "re_late_1",
      amountCents: 2500,
      kind: "primary",
      refundedCents: 3000,
      recoveredLostRecord: true,
    });
  });

  it("asks Stripe nothing when the capture has a task row of any kind", async () => {
    mocks.findLate.mockResolvedValueOnce(new Set([INTENT]));

    await expect(recoverLostLateCaptureRecord(capture(), { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
    expect(mocks.listRefunds).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ["a dashboard refund (no metadata)", { metadata: {} }],
    ["another booking's late-capture refund", { metadata: buildLateCaptureRefundMetadata("booking-2") }],
    ["a refund Stripe refused", { status: "failed" }],
  ])("records nothing for %s", async (_label, overrides) => {
    mocks.listRefunds.mockResolvedValueOnce([stripeRefund(overrides)]);

    await expect(recoverLostLateCaptureRecord(capture(), { format: CLUB_FORMAT_TEST })).resolves.toBe(false);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("lets a Stripe failure through, so the webhook answers 500 rather than acknowledging", async () => {
    mocks.listRefunds.mockRejectedValueOnce(new Error("Stripe is unreachable"));
    await expect(recoverLostLateCaptureRecord(capture(), { format: CLUB_FORMAT_TEST })).rejects.toThrow("Stripe is unreachable");
  });
});

describe("recoverLostLateCaptureRecordsForPayment — the nightly self-heal's check", () => {
  function armPayment(status = "CANCELLED") {
    mocks.paymentFindUnique.mockResolvedValue({
      bookingId: "booking-1",
      booking: {
        status,
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        deletedAt: null,
        memberId: "member-1",
        member: { firstName: "Alice", lastName: "Example" },
        organisation: null,
      },
    });
    mocks.paymentRefundFindMany.mockResolvedValue([
      { stripePaymentIntentId: INTENT, status: "succeeded" },
      { stripePaymentIntentId: "pi_cancel", status: "succeeded" },
    ]);
    mocks.paymentTransactionFindUnique.mockImplementation(async ({ where }: { where: { stripePaymentIntentId: string } }) => ({
      paymentId: "payment-1",
      kind: "PRIMARY",
      amountCents: where.stripePaymentIntentId === INTENT ? 2500 : 12000,
      reason: where.stripePaymentIntentId === INTENT ? "cancelled_booking_late_capture" : null,
    }));
    mocks.landedAfter.mockImplementation(async ({ paymentIntentId }: { paymentIntentId: string }) => paymentIntentId === INTENT);
  }

  it("records a late capture whose record was lost, with a bounded Stripe read, and leaves the cancel's own refund alone", async () => {
    armPayment();

    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [INTENT], unresolved: false });

    // Only the capture that landed after the cancel is asked about.
    expect(mocks.listRefunds).toHaveBeenCalledTimes(1);
    expect(mocks.listRefunds).toHaveBeenCalledWith(INTENT, { timeoutMs: 10_000 });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: INTENT, amountCents: 2500, memberName: "Alice Example", captureKind: "primary" }),
    );
  });

  it("checks nothing on a booking that is not cancelled", async () => {
    armPayment("CONFIRMED");
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
    expect(mocks.paymentRefundFindMany).not.toHaveBeenCalled();
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("skips a capture that already has its record", async () => {
    armPayment();
    mocks.findLate.mockResolvedValueOnce(new Set([INTENT]));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: false });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("says it could not check when Stripe or the record write fails, so the caller raises no card note tonight", async () => {
    armPayment();
    mocks.listRefunds.mockRejectedValueOnce(new Error("timeout"));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });

    mocks.record.mockResolvedValueOnce({ ...RECORDED, recorded: false });
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });
  });

  it("says it could not check when its own reads fail, and never throws", async () => {
    mocks.paymentFindUnique.mockRejectedValueOnce(new Error("database is down"));
    await expect(recoverLostLateCaptureRecordsForPayment("payment-1")).resolves.toEqual({ recovered: [], unresolved: true });
  });
});
