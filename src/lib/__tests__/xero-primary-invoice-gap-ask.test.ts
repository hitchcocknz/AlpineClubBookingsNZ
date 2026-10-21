import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  payment: { findUnique: vi.fn() },
  bookingModification: { findUnique: vi.fn() },
  xeroSyncOperation: { findMany: vi.fn(), updateMany: vi.fn() },
  paymentTransaction: { findFirst: vi.fn() },
  lock: vi.fn(),
  release: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => {
  const tx = {
    payment: mocks.payment,
    bookingModification: mocks.bookingModification,
    xeroSyncOperation: mocks.xeroSyncOperation,
    paymentTransaction: mocks.paymentTransaction,
  };
  return { prisma: { ...tx, $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) } };
});
vi.mock("@/lib/payment-transactions", () => ({ lockPaymentForRefundedTotal: mocks.lock }));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: mocks.release,
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { settleParkedGapInvoice } from "@/lib/xero-primary-invoice-gap-ask";

/**
 * #3980 review round 2 (F2/F3/F4/F5): a gap invoice waiting on its anchor's card
 * ask is settled against the ask as it now stands, under the Payment row lock a
 * reduction's retire of that ask takes first.
 */
const ANCHOR = {
  id: "mod_ask",
  priceDiffCents: 8_000,
  changeFeeCents: 0,
  createdAt: new Date("2026-06-25T00:00:00.000Z"),
  newData: {
    primaryInvoiceSettlement: {
      settledAgainstPrimaryInvoice: true,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      unpaidAskOffsetCents: 0,
      cardAskCents: 8_000,
    },
  },
};
const waitingOn = (paymentIntentId: string | null, id = "op_gap") => ({
  id,
  requestPayload: {
    queueType: "SUPPLEMENTARY_INVOICE",
    bookingId: "booking_1",
    bookingModificationId: "mod_ask",
    priceDiffCents: 8_000,
    changeFeeCents: 0,
    recordPayment: true,
    paymentIntentId,
    waitForConfirmedAdditionalPayment: true,
  },
});
const ask = (overrides: Record<string, unknown> = {}) => ({
  stripePaymentIntentId: "pi_ask",
  status: "PENDING",
  withdrawnAt: null,
  amountCents: 8_000,
  carriedAskCents: 0,
  ...overrides,
});
const settle = () => settleParkedGapInvoice({ bookingId: "booking_1", bookingModificationId: "mod_ask" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
  mocks.payment.findUnique.mockResolvedValue({ id: "pay_1" });
  mocks.lock.mockImplementation(async () => {
    mocks.calls.push("lock");
  });
  mocks.bookingModification.findUnique.mockResolvedValue(ANCHOR);
  mocks.xeroSyncOperation.findMany.mockResolvedValue([waitingOn(null)]);
  mocks.xeroSyncOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.paymentTransaction.findFirst.mockImplementation(async () => {
    mocks.calls.push("read-ask");
    return ask();
  });
});

describe("settleParkedGapInvoice (#3980 review round 2)", () => {
  it("MUTATION F4: reads the ask only under the Payment row lock the retire takes first", async () => {
    await settle();
    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), "pay_1");
    expect(mocks.calls).toEqual(["lock", "read-ask"]);
  });

  it("attaches a newly minted intent to the invoice waiting on none", async () => {
    await expect(settle()).resolves.toMatchObject({ attached: ["op_gap"], raisedUnpaid: [] });
    expect(mocks.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op_gap", status: "WAITING_PAYMENT" },
      data: { requestPayload: expect.objectContaining({ paymentIntentId: "pi_ask", recordPayment: true }) },
    });
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("MUTATION F3/F4: an ask a reduction retired (or an officer withdrew) raises the invoice unpaid, never leaving it on a dead intent", async () => {
    mocks.xeroSyncOperation.findMany.mockResolvedValue([waitingOn("pi_ask")]);
    mocks.paymentTransaction.findFirst.mockResolvedValue(ask({ status: "FAILED", withdrawnAt: new Date() }));
    await expect(settle()).resolves.toMatchObject({ raisedUnpaid: ["op_gap"] });
    expect(mocks.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "op_gap", status: "WAITING_PAYMENT" },
      data: {
        status: "PENDING",
        requestPayload: expect.objectContaining({
          recordPayment: false,
          paymentIntentId: null,
          waitForConfirmedAdditionalPayment: false,
        }),
      },
    });
  });

  it("MUTATION F5: a declined (FAILED) intent is dead to the re-check too - never attached", async () => {
    mocks.paymentTransaction.findFirst.mockResolvedValue(ask({ status: "FAILED" }));
    await expect(settle()).resolves.toMatchObject({ attached: [], raisedUnpaid: ["op_gap"] });
  });

  it("MUTATION F2: an ask whose own money is short of the gap is never attached; the invoice is raised unpaid", async () => {
    mocks.paymentTransaction.findFirst.mockResolvedValue(ask({ amountCents: 9_000, carriedAskCents: 3_000 }));
    await expect(settle()).resolves.toMatchObject({ attached: [], raisedUnpaid: ["op_gap"] });
  });

  it("F2: an ask already captured is released through the one capture path", async () => {
    mocks.xeroSyncOperation.findMany.mockResolvedValue([waitingOn("pi_ask")]);
    mocks.paymentTransaction.findFirst.mockResolvedValue(ask({ status: "SUCCEEDED" }));
    await expect(settle()).resolves.toMatchObject({ capturedIntentId: "pi_ask", raisedUnpaid: [] });
    expect(mocks.release).toHaveBeenCalledWith("pi_ask");
    expect(mocks.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
  });

  it("leaves an unminted ask waiting, and never touches an invoice waiting on another intent", async () => {
    mocks.paymentTransaction.findFirst.mockResolvedValue(null);
    await expect(settle()).resolves.toMatchObject({ attached: [], raisedUnpaid: [] });
    mocks.paymentTransaction.findFirst.mockResolvedValue(ask({ status: "FAILED" }));
    mocks.xeroSyncOperation.findMany.mockResolvedValue([waitingOn("pi_review_charge")]);
    await expect(settle()).resolves.toMatchObject({ attached: [], raisedUnpaid: [] });
    expect(mocks.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing for an edit that did not settle against the primary invoice", async () => {
    mocks.bookingModification.findUnique.mockResolvedValue({ ...ANCHOR, newData: {} });
    await expect(settle()).resolves.toEqual({ attached: [], raisedUnpaid: [], capturedIntentId: null });
    expect(mocks.xeroSyncOperation.findMany).not.toHaveBeenCalled();
  });
});
