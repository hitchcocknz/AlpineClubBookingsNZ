import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3924 round 11 (F1, `INV-PAY-122`): what the repair tool's record-by-hand
 * finding for a refund closed as paid another way names - the capture's
 * refunds (its card refunds and the close's bank cash alike) less the refund
 * notes naming the capture, as the kept invoice's own finding sized it. Read
 * only when the paid-another-way verdict says the receipt was resolved by hand.
 */
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  close: vi.fn(),
  noted: vi.fn(),
  capture: vi.fn(),
  noteRows: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findUnique: async () => ({ id: "task_late", paymentId: "payment_1" }) },
    xeroObjectLink: { findMany: async () => [] },
    xeroSyncOperation: { count: (...a: unknown[]) => mocks.noteRows(...a) },
    paymentTransaction: { findFirst: (...a: unknown[]) => mocks.capture(...a) },
  },
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  readPaidAnotherWayLateCaptureXeroReceipt: (...a: unknown[]) => mocks.receipt(...a),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  findLateCaptureRefundPaidAnotherWay: (...a: unknown[]) => mocks.close(...a),
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  sumLateCaptureNotedCents: (...a: unknown[]) => mocks.noted(...a),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn() }));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({ lockKeptLateCaptureTask: vi.fn() }));

import { readPaidAnotherWayReceiptState } from "@/lib/paid-another-way-receipt-note";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receipt.mockResolvedValue({ kind: "resolved-by-hand" });
  mocks.close.mockResolvedValue({ id: "close_1", paymentId: "payment_1", amountCents: 6000 });
  mocks.noteRows.mockResolvedValue(0);
  mocks.capture.mockResolvedValue({ refundedAmountCents: 10000 });
  mocks.noted.mockResolvedValue(3000);
});

describe("readPaidAnotherWayReceiptState: recordByHandCents (round 11)", () => {
  it("MUTATION: is the capture's refunds less the notes naming it, read by the paid-another-way verdict", async () => {
    const state = await readPaidAnotherWayReceiptState("pi_late");
    expect(state).toMatchObject({ close: { id: "close_1", amountCents: 6000 }, noteAsked: false, recordByHandCents: 7000 });
    expect(mocks.receipt).toHaveBeenCalledWith("pi_late");
    expect(mocks.capture).toHaveBeenCalledWith({
      where: { paymentId: "payment_1", source: "STRIPE", stripePaymentIntentId: "pi_late" },
      select: { refundedAmountCents: true },
    });
    expect(mocks.noted).toHaveBeenCalledWith("payment_1", "pi_late");
  });

  it("is never below nothing, and nothing without a refund", async () => {
    mocks.noted.mockResolvedValue(12000);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 0 });
    mocks.capture.mockResolvedValue({ refundedAmountCents: 0 });
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 0 });
  });

  it("is nothing for a receipt the app recorded: its note follows", async () => {
    mocks.receipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_kept" });
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 0 });
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
