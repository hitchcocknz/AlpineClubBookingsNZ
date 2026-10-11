/**
 * #3954 decision A (owner, 9 Oct 2026, "Raise a $30 invoice"): once a price
 * reduction's smaller re-issued ask is minted, its own supplementary invoice is
 * queued on the reducing edit, waiting on that intent and recording the
 * payment when it is captured - for the figure the reduction recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  newData: null as unknown,
  byId: null as null | Record<string, unknown>,
  enqueue: vi.fn(async (...args: unknown[]) => { void args; return { queueOperationId: "op_1", outcome: "covers-total" }; }),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingModification: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        newData: h.byId ? h.byId[where.id] : h.newData,
      })),
    },
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: h.enqueue }));
vi.mock("@/lib/logger", () => ({ default: { error: h.error, warn: vi.fn(), info: vi.fn() } }));

const { queueFoldedReissuedAskInvoices, queueReissuedAskSupplementaryInvoice } = await import("@/lib/reissued-ask-invoice");
const { NO_FOLDED_REISSUED_ASKS, NO_UNPAID_ASK_SETTLEMENT, unpaidAskOffsetHistory } = await import("@/lib/unpaid-ask-offset-marker");

const CALL = { bookingId: "booking_1", bookingModificationId: "mod_reduction", paymentIntentId: "pi_reissued" };

beforeEach(() => {
  vi.clearAllMocks();
  h.byId = null;
});

describe("queueReissuedAskSupplementaryInvoice", () => {
  it("MUTATION: queues the recorded figure on the reducing edit, waiting on the minted intent and recording its payment", async () => {
    h.newData = unpaidAskOffsetHistory({
      unpaidAskOffsetCents: 2_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 3_000,
      unpaidAskBilledOffsetCents: 0,
      unpaidAskBilledOffsetUnsureCents: 0,
      foldedReissuedAsks: NO_FOLDED_REISSUED_ASKS,
    });
    await queueReissuedAskSupplementaryInvoice(CALL);

    expect(h.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 3_000, changeFeeCents: 0, bookingModificationId: "mod_reduction" },
      { paymentIntentId: "pi_reissued", waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  });

  it("queues nothing where the reduction recorded no invoice (the ask was cancelled, or Xero already billed it)", async () => {
    h.newData = unpaidAskOffsetHistory({
      unpaidAskOffsetCents: 5_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 0,
      unpaidAskBilledOffsetCents: 0,
      unpaidAskBilledOffsetUnsureCents: 0,
      foldedReissuedAsks: NO_FOLDED_REISSUED_ASKS,
    });
    await queueReissuedAskSupplementaryInvoice(CALL);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("logs a failure for the repair pass rather than failing the mint", async () => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    h.enqueue.mockRejectedValueOnce(new Error("database is down"));
    await expect(queueReissuedAskSupplementaryInvoice(CALL)).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledTimes(1);
  });
});

describe("queueFoldedReissuedAskInvoices (#3954 round 6)", () => {
  it("MUTATION: queues each folded reduction's own invoice, anchored on that reduction and waiting on the INCREASE's intent", async () => {
    h.byId = {
      mod_increase: unpaidAskOffsetHistory({
        ...NO_UNPAID_ASK_SETTLEMENT,
        foldedReissuedAsks: { cents: 3_000, modificationIds: ["mod_reduction"], invoiceCents: 1_000 },
      }),
      mod_reduction: { reissuedAskInvoiceCents: 1_000 },
    };
    await queueFoldedReissuedAskInvoices({ bookingId: "booking_1", increaseModificationId: "mod_increase", paymentIntentId: "pi_increase" });

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 1_000, changeFeeCents: 0, bookingModificationId: "mod_reduction" },
      { paymentIntentId: "pi_increase", waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  });

  it("queues nothing for an increase that folded nothing in", async () => {
    h.byId = { mod_increase: {} };
    await queueFoldedReissuedAskInvoices({ bookingId: "booking_1", increaseModificationId: "mod_increase", paymentIntentId: "pi_increase" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
