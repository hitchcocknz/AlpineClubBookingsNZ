import { PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), lockPayment: vi.fn(), read: vi.fn(), global: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/payment-transactions", () => ({ lockPaymentForRefundedTotal: mocks.lockPayment }));

import { sizeAdditionalAsk, sizeReviewChargeAsk, restateAdditionalAsk } from "@/lib/additional-payment-ask";
import { sizeReissuedAskReplay } from "@/lib/additional-ask-recovery-replay";
import { withAdditionalAskQueueTransaction } from "@/lib/additional-ask-queue-transaction";

const unpaid = { additionalAmountCents: 7000, additionalPaymentStatus: PaymentStatus.PENDING };
const captured = { ...unpaid, additionalPaymentStatus: PaymentStatus.SUCCEEDED };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (write) => write({
    $executeRaw: mocks.global,
    payment: { findUniqueOrThrow: mocks.read },
  }));
  mocks.read.mockResolvedValue(unpaid);
});

describe("additional ask queue's sizing fence (#4442)", () => {
  it.each([
    ["ordinary increase", () => sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid })],
    ["review charge", () => sizeReviewChargeAsk({ shareTotalCents: 3000, payment: unpaid })],
    ["re-issued reduction", () => sizeReissuedAskReplay({ frozenAmountCents: 3000, payment: unpaid })],
    ["currency re-issue", () => restateAdditionalAsk({ amountCents: 7000, carriedAskCents: 2000 })],
  ])("refuses %s when A captures after sizing, before any B write or cancellation", async (_name, size) => {
    const ask = size();
    mocks.read.mockResolvedValue(captured);
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("retry and re-plan");
    expect(write).not.toHaveBeenCalled();
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "payment" } }));
  });

  it("locks global, then Payment, then re-reads before queueing an unchanged balance", async () => {
    const order: string[] = [];
    mocks.global.mockImplementation(async () => { order.push("global"); });
    mocks.lockPayment.mockImplementation(async () => { order.push("payment"); });
    mocks.read.mockImplementation(async () => { order.push("read"); return unpaid; });
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    await withAdditionalAskQueueTransaction("payment", ask, async () => { order.push("write-and-queue"); });
    expect(order).toEqual(["global", "payment", "read", "write-and-queue"]);
  });

  it("keeps folded waiting re-issues separate from the live balance", async () => {
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid, waitingReissuedAskCents: 2500 });
    const write = vi.fn().mockResolvedValue("queued");
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).resolves.toBe("queued");
    expect(ask.amountCents).toBe(12500);
    expect(ask.carriedCents).toBe(9500);
    mocks.read.mockResolvedValue(captured);
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("retry and re-plan");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("refuses a failed sizing re-read without queueing anything", async () => {
    mocks.read.mockRejectedValue(new Error("database unavailable"));
    const ask = sizeAdditionalAsk({ priceDiffCents: 3000, changeFeeCents: 0, payment: unpaid });
    const write = vi.fn();
    await expect(withAdditionalAskQueueTransaction("payment", ask, write)).rejects.toThrow("database unavailable");
    expect(write).not.toHaveBeenCalled();
  });
});
