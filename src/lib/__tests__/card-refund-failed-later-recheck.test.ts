// #4210 round 4 (`INV-PAY-136`, the deploy window): the runner weighs a
// failed-later row an older release raised - it carries no
// `paidAnotherWayWeighed` mark - against the "Paid another way" closes before
// it sends it, and holds it as a dead check where one may have paid it back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findPayment: vi.fn(),
  findRows: vi.fn(),
  findRefunds: vi.fn(),
  findClose: vi.fn(),
  put: vi.fn(),
  createAuditLog: vi.fn(),
  alert: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: (...args: unknown[]) => mocks.createAuditLog(...args) }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.logError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/email/admin-alerts-card-refund", () => ({ alertCardRefundFailedAfterPaidAnotherWay: (...args: unknown[]) => mocks.alert(...args) }));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: vi.fn() }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));
vi.mock("@/lib/prisma", () => {
  const tx = { paymentRecoveryOperation: { updateMany: (...args: unknown[]) => mocks.put(...args) } };
  return {
    prisma: {
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      payment: { findUnique: (...args: unknown[]) => mocks.findPayment(...args) },
      paymentRecoveryOperation: { findMany: (...args: unknown[]) => mocks.findRows(...args) },
      paymentRefund: { findMany: (...args: unknown[]) => mocks.findRefunds(...args) },
      manualRefundTask: { findFirst: (...args: unknown[]) => mocks.findClose(...args) },
    },
  };
});

import { holdFailedLaterRowForCheck } from "@/lib/card-refund-failed-later-recheck";
import { paidAnotherWayCountedContext } from "@/lib/card-refund-paid-another-way-counted";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");
const MADE_AT = new Date("2026-06-20T00:00:05.000Z");
const CLOSED_AT = new Date("2026-06-20T00:00:10.000Z");
const RECORDED_LATE = new Date("2026-06-20T00:00:20.000Z");
const CLAIMED_AT = new Date("2026-06-25T00:00:00.000Z");

const cancelRow = {
  id: "op-cancel",
  type: "REFUND_BOOKING_MODIFICATION",
  status: "SUCCEEDED",
  attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
  idempotencyKey: "booking_cancel_refund_recovery_booking-1",
  amountCents: 4_000,
  allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
  paymentTransactionId: null,
  createdAt: RAISED_AT,
  succeededAt: CLOSED_AT,
};

/** The row an older release raised for X, as the runner has just claimed it. */
const claimed = (plan: Record<string, unknown> = { paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-cancel" }, over: Record<string, unknown> = {}) =>
  ({
    id: "op-fl",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "PROCESSING",
    attempts: 1,
    nextRetryAt: null,
    processingStartedAt: CLAIMED_AT,
    idempotencyKey: "card_refund_failed_later_re_1",
    stripeKeyPrefix: "card_refund_failed_later_re_1",
    amountCents: 4_000,
    allocationPlan: [plan],
    paymentTransactionId: null,
    bookingId: "booking-1",
    paymentId: "pay-1",
    paymentIntentId: "pi_1",
    createdAt: new Date("2026-06-24T00:00:00.000Z"),
    succeededAt: null,
    lastError: null,
    ...over,
  }) as never;

const closeRecord = (refundIds: string[] = []) => ({
  id: "task-close",
  amountCents: 4_000,
  raisedAmountCents: 4_000,
  reviewContext: paidAnotherWayCountedContext({ refundIds, unsentSlices: refundIds.length > 0 ? [] : [{ paymentTransactionId: "txn-1", amountCents: 4_000, exact: true }] }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findPayment.mockResolvedValue({ id: "pay-1", bookingId: "booking-1", status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 4_000 });
  mocks.findRows.mockImplementation(async () => [cancelRow, claimed()]);
  mocks.findRefunds.mockResolvedValue([{ stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000, status: "failed", createdAt: RECORDED_LATE, stripeCreatedAt: MADE_AT }]);
  mocks.findClose.mockResolvedValue(closeRecord());
  mocks.put.mockResolvedValue({ count: 1 });
  mocks.createAuditLog.mockResolvedValue(undefined);
  mocks.alert.mockResolvedValue(undefined);
});

describe("the runner weighs a failed-later row an older release raised (#4210)", () => {
  it("MUTATION: a close that paid its refund back - held as a dead check on the claim it holds, audited and alerted, never sent", async () => {
    expect(await holdFailedLaterRowForCheck(claimed())).toBe(true);
    expect(mocks.put).toHaveBeenCalledWith({
      where: { id: "op-fl", status: "PROCESSING", processingStartedAt: CLAIMED_AT },
      data: expect.objectContaining({
        status: "PENDING",
        attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
        processingStartedAt: null,
        allocationPlan: [
          { paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-cancel", paidAnotherWayWeighed: true, paidAnotherWayCheck: { closedOperationId: "op-cancel", reason: "uncertain" } },
        ],
      }),
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking-payment.card-refund.failed-later-paid-another-way", entityId: "re_1", category: "payment", metadata: expect.objectContaining({ decision: "raised-check-uncertain", heldByRunner: true }) }),
      expect.anything(),
    );
    expect(mocks.alert).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a row this release raised (weighed already) is sent as it stands, with nothing read", async () => {
    expect(await holdFailedLaterRowForCheck(claimed({ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-cancel", paidAnotherWayWeighed: true }))).toBe(false);
    expect(mocks.findRows).not.toHaveBeenCalled();
  });

  it("any other row is sent as it stands, with nothing read", async () => {
    expect(await holdFailedLaterRowForCheck(claimed(undefined, { idempotencyKey: "booking_cancel_refund_recovery_booking-1" }))).toBe(false);
    expect(mocks.findRows).not.toHaveBeenCalled();
  });

  it("MUTATION (control): the close counted the refund as made - owed again, sent", async () => {
    mocks.findClose.mockResolvedValue(closeRecord(["re_1"]));
    expect(await holdFailedLaterRowForCheck(claimed())).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("a claim the reaper took back meanwhile: nothing written, never sent from here", async () => {
    mocks.put.mockResolvedValue({ count: 0 });
    expect(await holdFailedLaterRowForCheck(claimed())).toBe(true);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("MUTATION: a read that fails leaves the claim for the reaper - never a send", async () => {
    mocks.findRows.mockRejectedValue(new Error("database is down"));
    expect(await holdFailedLaterRowForCheck(claimed())).toBe(true);
    expect(mocks.logError).toHaveBeenCalled();
  });
});
