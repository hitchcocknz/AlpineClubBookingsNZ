// #4103 (`INV-PAY-128`): the edit financial review's card refund and the
// treasurer-approved late-capture refund write their recovery row BEFORE the
// inline attempt. A refund Stripe answers `failed` or `canceled` without
// throwing must leave that row open, re-planned on a fresh key, and must never
// be reported as refunded - no close, no REFUNDED event, no refund id, no
// record or Xero note. Each door: a clean refusal, a refusal then a throw, one
// slice made beside one refused, and a replay against a row a worker holds.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const updateMany = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
const findUnique = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ id: "op_row", paymentIntentId: "pi_row" })));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany, findUnique } } }));

const refundPaymentTransactions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payment-transactions")>()),
  refundPaymentTransactions,
}));

const markEditFinancialReviewRefundRecoverySucceeded = vi.hoisted(() => vi.fn(async (_args?: unknown) => ({ count: 1 })));
vi.mock("@/lib/payment-recovery", () => ({
  markEditFinancialReviewRefundRecoverySucceeded,
  buildBookingModificationRefundMetadata: (bookingId: string, reason: string) => ({ bookingId, reason }),
  enqueueLateCaptureApprovalRefundRecovery: vi.fn(),
}));

const recordBookingEvent = vi.hoisted(() => vi.fn(async (_args?: unknown) => undefined));
vi.mock("@/lib/booking-events", () => ({ recordBookingEvent }));
vi.mock("@/lib/edit-financial-review-xero-leg", () => ({ dispatchEditReviewXeroSettlement: vi.fn(async () => undefined) }));

const finishApprovedLateCaptureRefund = vi.hoisted(() => vi.fn(async (_args?: unknown) => undefined));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ finishApprovedLateCaptureRefund }));

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn(async (_args?: unknown, _format?: unknown) => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));

import { executeEditReviewSettlement } from "@/lib/edit-financial-review-settlement";
import { executeLateCaptureApprovalRefund, type LateCaptureRefundRoute } from "@/lib/late-capture-refund-approval";
import {
  buildEditFinancialReviewRefundRecoveryIdempotencyKey,
  buildLateCaptureApprovalRefundRecoveryIdempotencyKey,
} from "@/lib/payment-recovery-keys";
import { PartialRefundError, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const a: RefundAllocationSlice = { paymentTransactionId: "txn_a", amountCents: 3000 };
const b: RefundAllocationSlice = { paymentTransactionId: "txn_b", amountCents: 2000 };
const answer = (slice: RefundAllocationSlice, status: string) => ({
  status,
  slice,
  refundId: `re_${slice.paymentTransactionId}`,
  paymentIntentId: `pi_${slice.paymentTransactionId}`,
  amountCents: slice.amountCents,
});
const refusedThenThrown = () =>
  new PartialRefundError({
    completedRefundCents: 0,
    refunds: [answer(a, "failed")],
    refusedSlices: [a],
    cause: new Error("network"),
    format: CLUB_FORMAT_TEST,
  });

/** The re-plan the door wrote, on the row with this key. */
function replanOn(idempotencyKey: string) {
  const call = updateMany.mock.calls.find(([args]) => {
    const where = (args as { where?: { idempotencyKey?: string; status?: unknown } }).where;
    return where?.idempotencyKey === idempotencyKey && where.status === "PENDING";
  });
  return (call?.[0] as { data: { allocationPlan: unknown } } | undefined)?.data.allocationPlan;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("the edit financial review's card refund (#4103)", () => {
  const key = buildEditFinancialReviewRefundRecoveryIdempotencyKey("task_1");
  const settle = () =>
    executeEditReviewSettlement({
      bookingId: "b1",
      taskId: "task_1",
      actingMemberId: "officer_1",
      route: { kind: "stripe-refund", paymentId: "pay_1", bookingModificationId: "mod_1", allocation: [a, b], refundCents: 5000, creditBackCents: 0 },
      amountCents: 5000,
      accountCredit: null,
      hasIssuedXeroInvoice: false,
      bookingPaymentStatus: "PAID",
      format: CLUB_FORMAT_TEST,
    } as Parameters<typeof executeEditReviewSettlement>[0]);

  it("a clean refusal: the row stays open, re-planned on the next key; no refund id, no REFUNDED event; alerted once", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "failed"), answer(b, "canceled")] });

    const result = await settle();

    expect(result.stripeRefundId).toBeNull();
    expect(markEditFinancialReviewRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(recordBookingEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "REFUNDED" }));
    expect(replanOn(key)).toEqual([
      { ...a, stripeKeySuffix: "refused1" },
      { ...b, stripeKeySuffix: "refused1" },
    ]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }), CLUB_FORMAT_TEST);
  });

  it("one slice made beside one refused: the made one is marked, never sent again; still not closed or reported", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "succeeded"), answer(b, "failed")] });

    const result = await settle();

    expect(result.stripeRefundId).toBeNull();
    expect(markEditFinancialReviewRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(replanOn(key)).toEqual([{ ...a, madeRefundId: "re_txn_a" }, { ...b, stripeKeySuffix: "refused1" }]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 2000 }), CLUB_FORMAT_TEST);
  });

  it("refused then thrown: the refused slice moves, the one that threw keeps its key", async () => {
    refundPaymentTransactions.mockRejectedValue(refusedThenThrown());

    const result = await settle();

    expect(result.stripeRefundId).toBeNull();
    expect(replanOn(key)).toEqual([{ ...a, stripeKeySuffix: "refused1" }, b]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
  });

  it("a replay against a row a worker already holds: nothing moves, nobody is alerted, nothing is closed", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "failed"), answer(b, "succeeded")] });
    updateMany.mockResolvedValue({ count: 0 });

    const result = await settle();

    expect(result.stripeRefundId).toBeNull();
    expect(markEditFinancialReviewRefundRecoverySucceeded).not.toHaveBeenCalled();
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it("a refund Stripe made in full still closes the row and records the event, as before", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "succeeded"), answer(b, "pending")] });

    const result = await settle();

    expect(result.stripeRefundId).toBe("re_txn_a");
    expect(markEditFinancialReviewRefundRecoverySucceeded).toHaveBeenCalledWith({ taskId: "task_1" });
    expect(recordBookingEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "REFUNDED", amountCents: 5000 }));
    expect(replanOn(key)).toBeUndefined();
  });
});

describe("the treasurer-approved late-capture refund (#4103)", () => {
  const key = buildLateCaptureApprovalRefundRecoveryIdempotencyKey("pi_late");
  const route: LateCaptureRefundRoute = {
    kind: "late-capture-refund",
    paymentId: "pay_1",
    paymentIntentId: "pi_late",
    captureKind: "modification",
    bookingModificationId: null,
    allocation: [a, b],
  };
  const approve = () =>
    executeLateCaptureApprovalRefund({ bookingId: "b1", taskId: "task_1", actingMemberId: "officer_1", route, amountCents: 5000, format: CLUB_FORMAT_TEST });
  /** The approval's own close: any status but SUCCEEDED, on its row. */
  const closed = () =>
    updateMany.mock.calls.some(([args]) => (args as { data?: { status?: string } }).data?.status === "SUCCEEDED");

  it("a clean refusal: no refund id, no close, no record or Xero note; the row is re-planned and alerted once", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "canceled"), answer(b, "failed")] });

    expect(await approve()).toBeNull();
    expect(closed()).toBe(false);
    expect(finishApprovedLateCaptureRefund).not.toHaveBeenCalled();
    expect(replanOn(key)).toEqual([
      { ...a, stripeKeySuffix: "refused1" },
      { ...b, stripeKeySuffix: "refused1" },
    ]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
  });

  it("one made and one refused: the made slice is marked and the approval is not finished", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "succeeded"), answer(b, "failed")] });

    expect(await approve()).toBeNull();
    expect(closed()).toBe(false);
    expect(finishApprovedLateCaptureRefund).not.toHaveBeenCalled();
    expect(replanOn(key)).toEqual([{ ...a, madeRefundId: "re_txn_a" }, { ...b, stripeKeySuffix: "refused1" }]);
  });

  it("refused then thrown: the refused slice moves, the one that threw keeps its key", async () => {
    refundPaymentTransactions.mockRejectedValue(refusedThenThrown());

    expect(await approve()).toBeNull();
    expect(replanOn(key)).toEqual([{ ...a, stripeKeySuffix: "refused1" }, b]);
    expect(finishApprovedLateCaptureRefund).not.toHaveBeenCalled();
  });

  it("a replay against a row a worker already holds: nothing moves, nobody is alerted, nothing is finished", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "failed"), answer(b, "failed")] });
    updateMany.mockResolvedValue({ count: 0 });

    expect(await approve()).toBeNull();
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
    expect(finishApprovedLateCaptureRefund).not.toHaveBeenCalled();
  });

  it("a refund Stripe made in full is closed and finished, as before", async () => {
    refundPaymentTransactions.mockResolvedValue({ refunds: [answer(a, "succeeded"), answer(b, "succeeded")] });

    expect(await approve()).toBe("re_txn_a");
    expect(closed()).toBe(true);
    expect(finishApprovedLateCaptureRefund).toHaveBeenCalledTimes(1);
  });
});
