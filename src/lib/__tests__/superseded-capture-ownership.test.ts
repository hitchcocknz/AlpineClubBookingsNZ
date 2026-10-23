import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource, PaymentTransactionKind } from "@prisma/client";

/**
 * #4300 (`INV-PAY-138`, `INV-SSOT`): one payment's superseded-machinery
 * reading, shared by the duplicate-capture guard and the settle. The readings
 * themselves (`superseded-intent-ownership.ts`) have their own suites; this
 * pins how they compose.
 */
const mocks = vi.hoisted(() => ({
  readSupersededCaptureHolds: vi.fn(),
  findLiveSupersededIntentOperation: vi.fn(),
}));

vi.mock("@/lib/superseded-intent-ownership", () => ({
  readSupersededCaptureHolds: mocks.readSupersededCaptureHolds,
  findLiveSupersededIntentOperation: mocks.findLiveSupersededIntentOperation,
}));

import { readSupersededOwnership, supersededMachineryOwnsCapture } from "@/lib/superseded-capture-ownership";

const captures = [{ stripePaymentIntentId: "pi_a", amountCents: 10000, refundedAmountCents: 0 }];
const findMany = vi.fn();
const tx = { paymentTransaction: { findMany } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue(captures);
  mocks.readSupersededCaptureHolds.mockResolvedValue({ holdsForMember: new Set(), owedBackAtAll: new Set() });
  mocks.findLiveSupersededIntentOperation.mockResolvedValue(null);
});

describe("readSupersededOwnership", () => {
  it("weighs the payment's held PRIMARY Stripe captures", async () => {
    await readSupersededOwnership(tx, "pay-1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paymentId: "pay-1", kind: PaymentTransactionKind.PRIMARY, source: PaymentSource.STRIPE }),
      }),
    );
    expect(mocks.readSupersededCaptureHolds).toHaveBeenCalledWith(tx, "pay-1", captures);
  });

  it("owns a capture the Xero reading holds for the member", async () => {
    mocks.readSupersededCaptureHolds.mockResolvedValue({ holdsForMember: new Set(["pi_a"]), owedBackAtAll: new Set(["pi_a"]) });
    const ownership = await readSupersededOwnership(tx, "pay-1");
    expect(ownership.holdsForMember.has("pi_a")).toBe(true);
    await expect(ownership.owns("pi_a")).resolves.toBe(true);
  });

  it("owns a capture a superseded-intent row not SUCCEEDED names (c′)", async () => {
    mocks.findLiveSupersededIntentOperation.mockResolvedValue({ id: "op-1" });
    await expect((await readSupersededOwnership(tx, "pay-1")).owns("pi_a")).resolves.toBe(true);
    expect(mocks.findLiveSupersededIntentOperation).toHaveBeenCalledWith(tx, "pi_a");
  });

  it("a capture owed back only in part: not the guard's (it still holds cash), but the settle's", async () => {
    mocks.readSupersededCaptureHolds.mockResolvedValue({ holdsForMember: new Set(), owedBackAtAll: new Set(["pi_a"]) });
    const ownership = await readSupersededOwnership(tx, "pay-1");
    await expect(ownership.owns("pi_a")).resolves.toBe(false);
    await expect(ownership.owns("pi_a", { anyOwedBack: true })).resolves.toBe(true);
  });

  it("nothing owns an ordinary capture", async () => {
    await expect((await readSupersededOwnership(tx, "pay-1")).owns("pi_a", { anyOwedBack: true })).resolves.toBe(false);
  });

  it("with no payment, reads (c′) alone", async () => {
    mocks.findLiveSupersededIntentOperation.mockResolvedValue({ id: "op-1" });
    await expect((await readSupersededOwnership(tx, null)).owns("pi_a")).resolves.toBe(true);
    expect(findMany).not.toHaveBeenCalled();
    expect(mocks.readSupersededCaptureHolds).not.toHaveBeenCalled();
  });
});

describe("supersededMachineryOwnsCapture", () => {
  it("is the settle's reading: anything owed back counts", async () => {
    mocks.readSupersededCaptureHolds.mockResolvedValue({ holdsForMember: new Set(), owedBackAtAll: new Set(["pi_a"]) });
    await expect(supersededMachineryOwnsCapture(tx, { paymentId: "pay-1", paymentIntentId: "pi_a" })).resolves.toBe(true);
  });
});
