import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    paymentTransaction: { updateMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      paymentTransaction: { findMany: vi.fn() },
      payment: { findUnique: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: vi.fn(),
    lockPayment: vi.fn(),
    recordBank: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: vi.fn() }));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: mocks.lockPayment,
  recordInternetBankingPaymentTransaction: mocks.recordBank,
}));
vi.mock("@/lib/xero-invoice-balance", async () => {
  const actual = await vi.importActual<typeof import("@/lib/xero-invoice-balance")>("@/lib/xero-invoice-balance");
  return { ...actual, readXeroInvoiceBalance: vi.fn() };
});

import { closeCreditReleaseAsksPaidInXero, CREDIT_RELEASE_PAID_IN_XERO_REASON } from "@/lib/credit-release-ask-close";
import { CREDIT_RELEASE_ASK_REASON } from "@/lib/payment-recovery-keys";

/*
  #4253 (`INV-ADDPAY-045`, owner decision D6): a request is closed when Xero shows its
  invoice paid, the card payment cancelled first, and the money written as bank cash.
*/
const NOW = new Date("2026-07-01T00:00:00.000Z");
const ask = { id: "ask-1", paymentId: "pay-1", amountCents: 4000, stripePaymentIntentId: "pi_1" };

const paid = { invoiceId: "inv-1", status: "PAID", amountDueCents: 0, invoiceNumber: "INV-1" };
const open = { invoiceId: "inv-1", status: "AUTHORISED", amountDueCents: 4000, invoiceNumber: "INV-1" };

function deps(balance = paid, cancel: unknown = { canceled: true, paymentIntent: { status: "canceled" } }) {
  return {
    readInvoiceBalance: vi.fn().mockResolvedValue(balance),
    cancelIntent: vi.fn().mockResolvedValue(cancel),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.paymentTransaction.findMany.mockResolvedValue([ask]);
  mocks.prisma.payment.findUnique.mockResolvedValue({
    xeroInvoiceId: "inv-1",
    additionalPaymentIntentId: "pi_1",
    booking: { id: "bk-1", memberId: "m-1", member: { id: "m-1", firstName: "A", lastName: "B", email: "a@example.test" } },
  });
  mocks.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mocks.tx));
  mocks.tx.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
});

describe("closeCreditReleaseAsksPaidInXero", () => {
  it("only looks at unpaid, unwithdrawn credit-release requests that carry nothing", async () => {
    await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW });
    const where = mocks.prisma.paymentTransaction.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      kind: PaymentTransactionKind.ADDITIONAL,
      reason: CREDIT_RELEASE_ASK_REASON,
      withdrawnAt: null,
      carriedAskCents: 0,
    });
    expect(where.status.in).not.toContain(PaymentStatus.SUCCEEDED);
  });

  it("cancels the card payment, retires the request and books the money as bank cash", async () => {
    const d = deps();
    const result = await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW });
    expect(result).toEqual({ closed: 1, left: 0 });
    expect(d.cancelIntent).toHaveBeenCalledWith("pi_1", { cancellationReason: "duplicate" });
    expect(mocks.tx.paymentTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PaymentStatus.FAILED, withdrawnAt: NOW } }),
    );
    expect(mocks.recordBank).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        kind: PaymentTransactionKind.ADDITIONAL,
        amountCents: 4000,
        status: PaymentStatus.SUCCEEDED,
        reason: CREDIT_RELEASE_PAID_IN_XERO_REASON,
        store: mocks.tx,
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "payment.credit_release_ask.closed_paid_in_xero" }),
      mocks.tx,
    );
  });

  it("leaves a request alone while Xero still shows the invoice open, and never cancels its card payment", async () => {
    const d = deps(open);
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves a request alone when Xero cannot be read", async () => {
    const d = deps();
    (d as { readInvoiceBalance: ReturnType<typeof vi.fn> }).readInvoiceBalance.mockRejectedValue(new Error("down"));
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("leaves a request that is no longer the payment's live one", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({
      xeroInvoiceId: "inv-1",
      additionalPaymentIntentId: "pi_other",
      booking: { id: "bk-1" },
    });
    const d = deps();
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(d.cancelIntent).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "processing"])("leaves a request whose card payment is %s: the card won", async (status) => {
    const d = deps(paid, { canceled: false, paymentIntent: { status } });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: d, now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.recordBank).not.toHaveBeenCalled();
  });

  it("writes no cash when the fence is lost to another writer", async () => {
    mocks.tx.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });
    expect(await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW })).toEqual({ closed: 0, left: 1 });
    expect(mocks.recordBank).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("takes the global key and the payment lock before the fence", async () => {
    await closeCreditReleaseAsksPaidInXero({ deps: deps(), now: NOW });
    expect(mocks.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mocks.lockPayment).toHaveBeenCalledWith(mocks.tx, "pay-1");
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.lockPayment.mock.invocationCallOrder[0]!);
    expect(mocks.lockPayment.mock.invocationCallOrder[0]).toBeLessThan(mocks.tx.paymentTransaction.updateMany.mock.invocationCallOrder[0]!);
  });
});
