import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { xeroClaim } from "./helpers/xero-claim";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(),
  upsert: vi.fn(), claim: vi.fn(), send: vi.fn(), warn: vi.fn(),
}));
const store = {
  xeroSyncOperation: { updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow },
  xeroObjectLink: { upsert: mocks.upsert },
};
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 1_000_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 1000,
  claimAlertCooldown: mocks.claim,
  deferAlertCooldown: vi.fn(), releaseAlertCooldown: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/xero-hardening", () => ({ maybeNotifyXeroRepeatedFailure: vi.fn() }));

import { completeXeroSyncOperation } from "@/lib/xero-sync";

const link = { localModel: "Payment", localId: "payment-late", xeroObjectType: "PAYMENT", xeroObjectId: "pay-late", role: "STRIPE_PAYMENT" };
const completion = { xeroObjectType: "PAYMENT", xeroObjectId: "pay-late", extraLinks: [link] };

describe("#4374: success after an officer resolved the operation in Xero", () => {
  let row: XeroSyncOperation;
  let committed: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    row = {
      id: "op-late", status: "FAILED", startedAt: null, lastErrorCode: null,
      operationType: "CREATE", entityType: "PAYMENT", localModel: "Payment", localId: "payment-late",
      manuallyResolvedAt: new Date(), manuallyResolvedById: "officer", manuallyResolvedReason: "Raised by hand",
    } as XeroSyncOperation;
    committed = false;
    mocks.updateMany.mockImplementation(async ({ where, data }) => {
      if (!matchesWhere(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    });
    mocks.findUniqueOrThrow.mockImplementation(async () => ({ ...row }));
    mocks.transaction.mockImplementation(async (fn) => {
      const result = await fn(store);
      committed = true;
      return result;
    });
    const held = new Set<string>();
    mocks.claim.mockImplementation(async ({ key }) => {
      expect(committed).toBe(true);
      if (held.has(key)) return false;
      held.add(key);
      return true;
    });
    mocks.send.mockImplementation(async () => {
      expect(committed).toBe(true);
      return { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0 };
    });
  });

  it.each(["FAILED", "PARTIAL"])("lands on a manually resolved %s row, keeps links and warns officers once across repeats", async (status) => {
    row.status = status;
    await expect(completeXeroSyncOperation(xeroClaim(row.id), completion)).resolves.toMatchObject({
      status: "SUCCEEDED", xeroObjectId: "pay-late", manuallyResolvedReason: "Raised by hand",
    });
    await completeXeroSyncOperation(xeroClaim(row.id), completion);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining(link) }));
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ operationId: row.id }), expect.stringContaining("two documents"));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      operation: "CREATE PAYMENT (Payment payment-late)",
      errorMessage: expect.stringMatching(/two documents.*void one/),
    }));
    expect(row.manuallyResolvedAt).not.toBeNull();
  });

  it("does not alert for ordinary success", async () => {
    row.manuallyResolvedAt = null;
    await completeXeroSyncOperation(xeroClaim(row.id), completion);
    expect(row.status).toBe("SUCCEEDED");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("does not alert for a PARTIAL outcome on a manually resolved row", async () => {
    await completeXeroSyncOperation(xeroClaim(row.id), { status: "PARTIAL" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("defers delivery to the owner of an injected transaction", async () => {
    const result = await completeXeroSyncOperation(xeroClaim(row.id), completion, { store: store as never });
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(result?.deferredPostCommit).toBeTypeOf("function");
    committed = true;
    await result?.deferredPostCommit?.();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("does not alert when link recording rolls the transaction back", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("link write failed"));
    await expect(completeXeroSyncOperation(xeroClaim(row.id), completion)).rejects.toThrow("link write failed");
    expect(committed).toBe(false);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
