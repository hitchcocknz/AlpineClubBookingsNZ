import { PaymentSource, PaymentStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    paymentTransaction: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    payment: { findUnique: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
  },
  claimAlertCooldown: vi.fn(),
  sendAlert: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/alert-cooldown", () => ({ claimAlertCooldown: mocks.claimAlertCooldown }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.sendAlert }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn().mockResolvedValue("Pacific/Auckland") }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stripe-capture-date", () => ({ readStripeCaptureDocumentDate: vi.fn() }));
vi.mock("@/lib/xero-invoice-payments", () => ({ createXeroPaymentForInvoice: vi.fn() }));
vi.mock("@/lib/xero-invoice-balance", async () => {
  const actual = (await vi.importActual("@/lib/xero-invoice-balance")) as typeof import("@/lib/xero-invoice-balance");
  return { ...actual, readXeroInvoiceBalance: vi.fn() };
});

import {
  CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS,
  CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS,
  CREDIT_RELEASE_PAYMENT_ROLE,
  creditReleasePaymentIdempotencyKey,
  recordCreditReleasePayments,
} from "@/lib/credit-release-xero-payment";
import {
  CREDIT_RELEASE_ASK_REASON,
} from "@/lib/credit-release-ask-keys";

/*
  #4253 (`INV-ADDPAY-045`): the card payment for released credit is recorded against the
  booking's own invoice, fails closed, and retries a bounded number of times.
*/
const NOW = new Date("2026-07-01T00:00:00.000Z");

const releaseRow = {
  id: "ask-1",
  source: PaymentSource.STRIPE,
  status: PaymentStatus.SUCCEEDED,
  reason: CREDIT_RELEASE_ASK_REASON,
  amountCents: 4000,
  carriedAskCents: 0,
  withdrawnAt: null,
  stripePaymentIntentId: "pi_1",
};

function deps(over: { due?: number | null; status?: string } = {}) {
  const status = over.status ?? "AUTHORISED";
  return {
    readInvoiceBalance: vi.fn().mockResolvedValue({
      invoiceId: "inv-1",
      status,
      amountDueCents: over.due === undefined ? 4000 : over.due,
      invoiceNumber: "INV-1",
    }),
    createPayment: vi.fn().mockResolvedValue("xero-pay-1"),
    captureDate: vi.fn().mockResolvedValue("2026-06-30"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.paymentTransaction.findMany.mockResolvedValue([{ id: "ask-1", paymentId: "pay-1" }]);
  mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
  mocks.prisma.payment.findUnique.mockResolvedValue({ bookingId: "bk-12345678", xeroInvoiceId: "inv-1", transactions: [releaseRow] });
  mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue([]);
  mocks.claimAlertCooldown.mockResolvedValue(true);
});

describe("recordCreditReleasePayments", () => {
  it("records the card payment on the booking's invoice, dated the day Stripe took it, under a stable key", async () => {
    const d = deps();
    const result = await recordCreditReleasePayments({ deps: d, now: NOW });
    expect(result).toEqual({ recorded: 1, held: 0, failed: 0, waiting: 0 });
    expect(d.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "PaymentTransaction",
        localId: "ask-1",
        invoiceId: "inv-1",
        amountCents: 4000,
        idempotencyKey: creditReleasePaymentIdempotencyKey("ask-1", "inv-1"),
        reference: "Stripe pi_1",
        role: CREDIT_RELEASE_PAYMENT_ROLE,
        date: "2026-06-30",
      }),
    );
  });

  it("does nothing for a request whose payment is already linked", async () => {
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([{ localId: "ask-1" }]);
    const d = deps();
    expect(await recordCreditReleasePayments({ deps: d, now: NOW })).toEqual({ recorded: 0, held: 0, failed: 0, waiting: 0 });
    expect(d.createPayment).not.toHaveBeenCalled();
  });

  it("waits when the booking has no invoice yet", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({ bookingId: "bk-12345678", xeroInvoiceId: null, transactions: [releaseRow] });
    const d = deps();
    expect((await recordCreditReleasePayments({ deps: d, now: NOW })).waiting).toBe(1);
    expect(d.createPayment).not.toHaveBeenCalled();
  });

  it.each([
    ["the invoice is already paid", { due: 0, status: "PAID" }],
    ["the invoice is void", { due: 4000, status: "VOIDED" }],
    ["the invoice owes less than the card took", { due: 1000 }],
    ["Xero omitted the amount due", { due: null }],
  ])("fails closed and tells an officer once when %s", async (_name, over) => {
    const d = deps(over);
    const result = await recordCreditReleasePayments({ deps: d, now: NOW });
    expect(result.held).toBe(1);
    expect(d.createPayment).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an alert inside its cooldown", async () => {
    mocks.claimAlertCooldown.mockResolvedValue(false);
    await recordCreditReleasePayments({ deps: deps({ due: 0, status: "PAID" }), now: NOW });
    expect(mocks.sendAlert).not.toHaveBeenCalled();
  });

  it("waits when Xero cannot be read", async () => {
    const d = deps();
    d.readInvoiceBalance.mockRejectedValue(new Error("timeout"));
    expect((await recordCreditReleasePayments({ deps: d, now: NOW })).waiting).toBe(1);
    expect(d.createPayment).not.toHaveBeenCalled();
  });

  it("holds an unexplainable chain for an officer instead of guessing", async () => {
    mocks.prisma.payment.findUnique.mockResolvedValue({
      bookingId: "bk-12345678",
      xeroInvoiceId: "inv-1",
      transactions: [
        { ...releaseRow, id: "ask-0", status: PaymentStatus.PENDING, stripePaymentIntentId: "pi_0" },
        { ...releaseRow, id: "ask-1", reason: null, carriedAskCents: 100, amountCents: 5000 },
      ],
    });
    mocks.prisma.paymentTransaction.findMany.mockResolvedValue([{ id: "ask-0", paymentId: "pay-1" }]);
    const d = deps();
    const result = await recordCreditReleasePayments({ deps: d, now: NOW });
    expect(result.held).toBe(1);
    expect(d.createPayment).not.toHaveBeenCalled();
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
  });

  describe("retries", () => {
    const failedAt = (ms: number) => ({ createdAt: new Date(NOW.getTime() - ms) });

    it("backs off for an hour after a failed attempt", async () => {
      mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue([failedAt(CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS - 1000)]);
      const d = deps();
      expect((await recordCreditReleasePayments({ deps: d, now: NOW })).waiting).toBe(1);
      expect(d.createPayment).not.toHaveBeenCalled();
    });

    it("tries again once the back-off has passed", async () => {
      mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue([failedAt(CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS + 1000)]);
      const d = deps();
      expect((await recordCreditReleasePayments({ deps: d, now: NOW })).recorded).toBe(1);
    });

    it("stops at the attempt cap", async () => {
      mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue(
        Array.from({ length: CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS }, (_, i) => failedAt((i + 2) * CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS)),
      );
      const d = deps();
      expect((await recordCreditReleasePayments({ deps: d, now: NOW })).failed).toBe(1);
      expect(d.createPayment).not.toHaveBeenCalled();
    });

    it("counts a failed record, and alerts on the last allowed attempt", async () => {
      mocks.prisma.xeroSyncOperation.findMany.mockResolvedValue(
        Array.from({ length: CREDIT_RELEASE_PAYMENT_MAX_ATTEMPTS - 1 }, (_, i) => failedAt((i + 2) * CREDIT_RELEASE_PAYMENT_RETRY_AFTER_MS)),
      );
      const d = deps();
      d.createPayment.mockRejectedValue(new Error("400"));
      expect((await recordCreditReleasePayments({ deps: d, now: NOW })).failed).toBe(1);
      expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    });
  });
});
