import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4272: the recovery replay's cancelled-booking path. The record it writes is
 * proved against the real request module in `edit-financial-review-charge.test.ts`
 * (`settleCancelledEditReviewCharge`); here, the order around it - only on a
 * cancelled booking, only holding the edit's raise claim, and the row closed only
 * once the record is written.
 */
const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  complete: vi.fn(),
  sumShares: vi.fn(),
  findRequest: vi.fn(),
  record: vi.fn(),
  auditLogFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
    auditLog: { findMany: (...a: unknown[]) => mocks.auditLogFindMany(...a) },
    paymentTransaction: { findUnique: async () => ({ refundedAmountCents: 0 }) },
  },
}));
vi.mock("@/lib/edit-financial-review-charge-raise-claim", () => ({
  claimEditReviewChargeRaise: (...a: unknown[]) => mocks.claim(...a),
  releaseEditReviewChargeRaise: (...a: unknown[]) => mocks.release(...a),
}));
vi.mock("@/lib/edit-financial-review-charge-recovery", () => ({
  completeEditFinancialReviewChargeRecovery: (...a: unknown[]) => mocks.complete(...a),
}));
vi.mock("@/lib/edit-financial-review-charge-request", () => ({
  sumEditReviewChargeSharesCents: (...a: unknown[]) => mocks.sumShares(...a),
  findEditReviewChargeRequest: (...a: unknown[]) => mocks.findRequest(...a),
  recordUncollectedEditReviewChargeShare: (...a: unknown[]) => mocks.record(...a),
}));

import { closeCancelledEditReviewChargeReplay } from "@/lib/edit-financial-review-charge-cancelled";

const operation = {
  id: "op-1",
  bookingId: "booking-1",
  paymentId: "payment-1",
  nextRetryAt: null,
  processingStartedAt: new Date("2026-07-01T00:00:00.000Z"),
};
const args = { format: CLUB_FORMAT_TEST, operation, bookingModificationId: "mod-1", memberId: "member-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ bookingModificationId: "mod-1", token: "t-1" });
  mocks.release.mockResolvedValue(true);
  mocks.complete.mockResolvedValue(undefined);
  mocks.sumShares.mockResolvedValue(20000);
  mocks.findRequest.mockResolvedValue(null);
  mocks.record.mockResolvedValue(undefined);
  mocks.auditLogFindMany.mockResolvedValue([]);
});

describe("closeCancelledEditReviewChargeReplay (#4272)", () => {
  it("records the uncollected share under the claim, then closes the row", async () => {
    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).resolves.toBe(true);

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "booking-cancelled", bookingModificationId: "mod-1", memberId: "member-1" }),
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(mocks.record.mock.invocationCallOrder[0]);
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(operation);
  });

  it("re-reads the status when the caller has none (a cancellation landing mid-replay)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ status: "CANCELLED" });

    await expect(closeCancelledEditReviewChargeReplay(args)).resolves.toBe(true);

    expect(mocks.bookingFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it("CONTROL: a live booking is not its business - nothing claimed, recorded or closed", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ status: "PAID" });

    await expect(closeCancelledEditReviewChargeReplay(args)).resolves.toBe(false);
    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CONFIRMED" })).resolves.toBe(false);

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("throws, leaving the row open, when another run holds the edit's claim", async () => {
    mocks.claim.mockResolvedValue(null);

    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).rejects.toThrow(/holds the charge raise claim/);

    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("throws, leaving the row open, when the record cannot be written - and still releases the claim", async () => {
    mocks.record.mockRejectedValue(new Error("audit sink down"));

    await expect(closeCancelledEditReviewChargeReplay({ ...args, status: "CANCELLED" })).rejects.toThrow("audit sink down");

    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
