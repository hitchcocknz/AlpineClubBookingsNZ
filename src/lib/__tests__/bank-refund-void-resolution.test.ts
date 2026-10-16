import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4162 (`INV-ADDPAY-042`, `INV-LOCK-001`, `INV-LOCK-002`): the two answers to a
 * voided bank-transfer refund note take global `lock(1)` FIRST, then the
 * Payment row, and only then read the voided note. The money they move, the
 * claim and the races are `bank-refund-void-resolution.realdb.test.ts`'s; this
 * pins the order and the refusals that need no database.
 */

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  readPaymentId: vi.fn(),
  readUnderLock: vi.fn(),
  lockPayment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (run: (tx: unknown) => unknown) =>
      run({
        $executeRaw: async (strings: TemplateStringsArray) => {
          mocks.calls.push(`raw:${strings.join("?")}`);
          return 1;
        },
      }),
  },
}));
vi.mock("@/lib/bank-refund-void-report", () => ({
  readBankRefundVoidPaymentId: async (...args: unknown[]) => {
    mocks.calls.push("read-payment-id");
    return mocks.readPaymentId(...args);
  },
  readBankRefundVoidUnderLock: async (...args: unknown[]) => {
    mocks.calls.push("read-void");
    return mocks.readUnderLock(...args);
  },
  readVoidedNoteCreateRow: vi.fn(),
}));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: async (...args: unknown[]) => {
    mocks.calls.push("lock-payment-row");
    return mocks.lockPayment(...args);
  },
  unwindLocalRefundAllocation: vi.fn(),
  RefundAllocationRacedError: class extends Error {},
  RefundUnwindExceedsAllocatedError: class extends Error {},
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroRefundCreditNoteOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(async () => undefined),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
  BankRefundVoidResolutionError,
  confirmBankTransferRefundCancelled,
  reRecordBankTransferRefund,
} from "@/lib/bank-refund-void-resolution";

const input = { linkId: "link-1", expectedAmountCents: 20_000, note: "Paid by bank", actingMemberId: "officer-1" };

beforeEach(() => {
  mocks.calls.length = 0;
  vi.clearAllMocks();
  mocks.readPaymentId.mockResolvedValue("pay-1");
  // Already answered: each writer stops at the re-read, after its locks.
  mocks.readUnderLock.mockResolvedValue({
    link: { xeroObjectId: "cn-v" },
    paymentId: "pay-1",
    amountCents: 20_000,
    resolution: { id: "r-1", outcome: "RE_RECORDED" },
    reRecordRefusal: null,
  });
});

describe("the lock order (INV-LOCK-001, INV-LOCK-002)", () => {
  it.each([
    ["record again", () => reRecordBankTransferRefund(input)],
    ["confirm", () => confirmBankTransferRefundCancelled({ ...input, basis: "cancelled" })],
  ])("MUTATION: %s takes lock(1) first, then the Payment row, then reads the voided note", async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(mocks.calls[0]).toBe("raw:SELECT pg_advisory_xact_lock(1)");
    expect(mocks.calls.indexOf("lock-payment-row")).toBeGreaterThan(0);
    expect(mocks.calls.indexOf("read-void")).toBeGreaterThan(mocks.calls.indexOf("lock-payment-row"));
  });

  it("a link that names no payment is a 404, before any money is read", async () => {
    mocks.readPaymentId.mockResolvedValue(null);
    await expect(reRecordBankTransferRefund(input)).rejects.toMatchObject({ status: 404 });
    expect(mocks.calls).not.toContain("lock-payment-row");
  });
});

describe("refusals before anything is read", () => {
  it.each([
    [{ note: "  " }, 400],
    [{ expectedAmountCents: 0 }, 400],
    [{ expectedAmountCents: 1.5 }, 400],
  ])("refuses %o with %i", async (override, status) => {
    await expect(reRecordBankTransferRefund({ ...input, ...override })).rejects.toBeInstanceOf(BankRefundVoidResolutionError);
    await expect(reRecordBankTransferRefund({ ...input, ...override })).rejects.toMatchObject({ status });
    expect(mocks.calls).toEqual([]);
  });

  it("refuses a confirm with no reason chosen", async () => {
    await expect(
      confirmBankTransferRefundCancelled({ ...input, basis: "lost" as never }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.calls).toEqual([]);
  });

  it("refuses an amount that moved since the dialog opened", async () => {
    mocks.readUnderLock.mockResolvedValue({
      link: { xeroObjectId: "cn-v" },
      paymentId: "pay-1",
      amountCents: 19_000,
      resolution: null,
      reRecordRefusal: null,
    });
    await expect(reRecordBankTransferRefund(input)).rejects.toMatchObject({ status: 409 });
  });
});
