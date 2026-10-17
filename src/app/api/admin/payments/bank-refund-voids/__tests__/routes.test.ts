import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/re-record and
 * /confirm-cancelled (#4162, owner decisions 16 and 17 Oct 2026).
 *
 * The routes are the doors: finance:edit (explicitly, and by the
 * `/api/admin/payments` prefix gate), a confirmed body with a reason and the
 * figure the dialog showed, and the library's refusals answered with their
 * own status. What the answers do - the locks, the claim, the money - is
 * `bank-refund-void-resolution.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  reRecordBankTransferRefund: vi.fn(),
  confirmBankTransferRefundCancelled: vi.fn(),
  retryBankTransferRefundReRecord: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/bank-refund-void-retry", () => ({
  retryBankTransferRefundReRecord: mocks.retryBankTransferRefundReRecord,
}));
vi.mock("@/lib/bank-refund-void-resolution", () => ({
  reRecordBankTransferRefund: mocks.reRecordBankTransferRefund,
  confirmBankTransferRefundCancelled: mocks.confirmBankTransferRefundCancelled,
  BankRefundVoidResolutionError: class BankRefundVoidResolutionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import type { NextRequest } from "next/server";
import { getAdminRouteRequirement } from "@/lib/admin-permissions";
import { BankRefundVoidResolutionError } from "@/lib/bank-refund-void-resolution";
import { POST as reRecordPOST } from "../[id]/re-record/route";
import { POST as confirmPOST } from "../[id]/confirm-cancelled/route";
import { POST as retryPOST } from "../[id]/retry-re-record/route";

function request(path: string, body: unknown) {
  return new Request(`http://localhost/api/admin/payments/bank-refund-voids/link-1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "link-1" });
const reRecordBody = { expectedAmountCents: 20_000, note: "Paid by bank", confirmed: true };
const confirmBody = { reason: "cancelled", expectedAmountCents: 20_000, note: "Never paid", confirmed: true };
const retryBody = { note: "Xero was down", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.reRecordBankTransferRefund.mockResolvedValue({ resolutionId: "r-1" });
  mocks.confirmBankTransferRefundCancelled.mockResolvedValue({ resolutionId: "r-2" });
  mocks.retryBankTransferRefundReRecord.mockResolvedValue({ resolutionId: "r-1" });
});

describe("who may answer a voided bank-transfer refund note", () => {
  it("the /api/admin/payments prefix gate already asks finance:edit of a POST", () => {
    expect(getAdminRouteRequirement("/api/admin/payments/bank-refund-voids/link-1/re-record", "POST")).toEqual({
      area: "finance",
      level: "edit",
    });
    expect(getAdminRouteRequirement("/api/admin/payments/bank-refund-voids/link-1/confirm-cancelled", "POST")).toEqual({
      area: "finance",
      level: "edit",
    });
    expect(getAdminRouteRequirement("/api/admin/payments/bank-refund-voids/link-1/retry-re-record", "POST")).toEqual({
      area: "finance",
      level: "edit",
    });
  });

  it.each([
    ["re-record", reRecordPOST, reRecordBody],
    ["confirm-cancelled", confirmPOST, confirmBody],
    ["retry-re-record", retryPOST, retryBody],
  ] as const)("%s asks for finance:edit explicitly, and a refusal reads and writes nothing", async (path, handler, body) => {
    await handler(request(path, body), { params });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });

    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) });
    const res = await handler(request(path, body), { params });
    expect(res.status).toBe(403);
    expect(mocks.reRecordBankTransferRefund).not.toHaveBeenCalled();
    expect(mocks.confirmBankTransferRefundCancelled).not.toHaveBeenCalled();
    expect(mocks.retryBankTransferRefundReRecord).not.toHaveBeenCalled();
  });
});

describe("what each door asks for", () => {
  it("retry passes the link, an optional note and the acting treasurer, and refuses an unconfirmed body", async () => {
    expect((await retryPOST(request("retry-re-record", retryBody), { params })).status).toBe(200);
    expect(mocks.retryBankTransferRefundReRecord).toHaveBeenCalledWith({ linkId: "link-1", note: "Xero was down", actingMemberId: "treasurer-1" });
    expect((await retryPOST(request("retry-re-record", { confirmed: false }), { params })).status).toBe(400);
    mocks.retryBankTransferRefundReRecord.mockRejectedValue(new BankRefundVoidResolutionError("on its way", 409));
    expect((await retryPOST(request("retry-re-record", { confirmed: true }), { params })).status).toBe(409);
  });

  it("record again passes the link, the amount the dialog showed, the reason and the acting treasurer", async () => {
    const res = await reRecordPOST(request("re-record", reRecordBody), { params });
    expect(res.status).toBe(200);
    expect(mocks.reRecordBankTransferRefund).toHaveBeenCalledWith({
      linkId: "link-1",
      expectedAmountCents: 20_000,
      note: "Paid by bank",
      actingMemberId: "treasurer-1",
    });
  });

  it("confirm passes the reason chosen, and refuses one it does not know", async () => {
    await confirmPOST(request("confirm-cancelled", confirmBody), { params });
    expect(mocks.confirmBankTransferRefundCancelled).toHaveBeenCalledWith({
      linkId: "link-1",
      reason: "cancelled",
      expectedAmountCents: 20_000,
      note: "Never paid",
      actingMemberId: "treasurer-1",
    });
    const res = await confirmPOST(request("confirm-cancelled", { ...confirmBody, reason: "lost" }), { params });
    expect(res.status).toBe(400);
  });

  it.each([
    ["re-record", reRecordPOST, reRecordBody],
    ["confirm-cancelled", confirmPOST, confirmBody],
  ] as const)("%s refuses an unconfirmed body, or one carrying an amount to choose", async (path, handler, body) => {
    expect((await handler(request(path, { ...body, confirmed: false }), { params })).status).toBe(400);
    expect((await handler(request(path, { ...body, amountCents: 1 }), { params })).status).toBe(400);
    expect(mocks.reRecordBankTransferRefund).not.toHaveBeenCalled();
    expect(mocks.confirmBankTransferRefundCancelled).not.toHaveBeenCalled();
  });

  it("answers the library's refusal with its own status", async () => {
    mocks.reRecordBankTransferRefund.mockRejectedValue(new BankRefundVoidResolutionError("moved", 409));
    const res = await reRecordPOST(request("re-record", reRecordBody), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "moved" });
  });

  it("answers an unexpected fault with a 500 that says nothing more", async () => {
    mocks.confirmBankTransferRefundCancelled.mockRejectedValue(new Error("db down"));
    const res = await confirmPOST(request("confirm-cancelled", confirmBody), { params });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not confirm the refund." });
  });
});
