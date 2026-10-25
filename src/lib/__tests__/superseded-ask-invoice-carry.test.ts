import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere, type WhereRow } from "./support/prisma-where";

/*
  #3403 (owner decision 26 Oct 2026, "follow the money"; `INV-PAY-070`):
  A SUPERSEDED CARD CHANGE'S WAITING XERO INVOICE MOVES ONTO THE REQUEST THAT
  CARRIES ITS BALANCE.

  The real module runs over an in-memory store whose reads answer through the
  shared Prisma `where` evaluator; only the anchor lock, the receipt check and
  the late-capture release are doubled. The PostgreSQL proofs - the real
  writers, the capture, the reduction and the repair racing it - are
  `superseded-ask-invoice-carry.realdb.test.ts`.

  Frozen clock inherited; nothing here reads a date.
*/

const mocks = vi.hoisted(() => ({
  lockAnchor: vi.fn(),
  anchorCaptureHasReceipt: vi.fn(),
  releaseForCapture: vi.fn(),
  /** Runs just before an operation write, to model a writer landing between read and write. */
  beforeOperationWrite: { value: null as null | (() => void) },
}));

type Row = WhereRow & { id: string };
const store = {
  payments: [] as Row[],
  bookings: [] as Row[],
  transactions: [] as Row[],
  operations: [] as Row[],
  links: [] as Row[],
};

const where = (rows: Row[], filter: unknown) =>
  rows.filter((row) => matchesWhere(row, filter as Record<string, unknown>, { label: "carry test store" }));

vi.mock("@/lib/prisma", () => {
  const client = {
    payment: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const payment = store.payments.find((row) => row.id === id);
        if (!payment) return null;
        const booking = store.bookings.find((row) => row.id === payment.bookingId)!;
        return { bookingId: payment.bookingId, booking: { status: booking.status, deletedAt: booking.deletedAt } };
      },
    },
    booking: {
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const booking = store.bookings.find((row) => row.id === id);
        return booking ? { status: booking.status, deletedAt: booking.deletedAt } : null;
      },
    },
    paymentTransaction: {
      // Array order is ledger order (oldest first).
      findMany: async (args: { where: unknown }) => where(store.transactions, args.where).map((row) => ({ ...row })),
      findUnique: async ({ where: { id } }: { where: { id: string } }) => {
        const row = store.transactions.find((candidate) => candidate.id === id);
        return row ? { status: row.status } : null;
      },
    },
    xeroSyncOperation: {
      findMany: async (args: { where: unknown }) => where(store.operations, args.where).map((row) => ({ ...row })),
      findFirst: async (args: { where: unknown }) => where(store.operations, args.where)[0] ?? null,
      updateMany: async (args: { where: unknown; data: Record<string, unknown> }) => {
        mocks.beforeOperationWrite.value?.();
        const matched = where(store.operations, args.where);
        for (const row of matched) Object.assign(row, args.data);
        return { count: matched.length };
      },
    },
    xeroObjectLink: {
      findFirst: async (args: { where: unknown }) => where(store.links, args.where)[0] ?? null,
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return { prisma: client };
});
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  lockSupplementaryInvoiceAnchor: mocks.lockAnchor,
}));
vi.mock("@/lib/additional-capture-receipt-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/additional-capture-receipt-link")>()),
  anchorCaptureHasReceipt: mocks.anchorCaptureHasReceipt,
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: mocks.releaseForCapture,
}));

import {
  carrierAndSupersededRows,
  followSupersededAskInvoicesSafely,
  followSupersededAskInvoicesToCarrier,
} from "@/lib/superseded-ask-invoice-carry";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { supplementaryInvoiceWaitedFirstOn } from "@/lib/xero-operation-outbox-payload";

function ask(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id: `txn_${id}`,
    paymentId: "pay_1",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "PENDING",
    amountCents: 5000,
    carriedAskCents: 0,
    stripePaymentIntentId: `pi_${id}`,
    withdrawnAt: null,
    bookingModificationId: `mod_${id}`,
    reason: null,
    ...overrides,
  };
}

function waitingInvoice(anchor: string, intent: string, cents: number, overrides: Partial<Row> = {}): Row {
  return {
    id: `op_${anchor}`,
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    queueType: "SUPPLEMENTARY_INVOICE",
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    localId: anchor,
    manuallyResolvedAt: null,
    lastErrorCode: null,
    requestPayload: {
      queueType: "SUPPLEMENTARY_INVOICE",
      bookingId: "booking_1",
      priceDiffCents: cents,
      changeFeeCents: 0,
      bookingModificationId: anchor,
      recordPayment: true,
      paymentIntentId: intent,
      waitForConfirmedAdditionalPayment: true,
    },
    ...overrides,
  };
}

const payloadOf = (id: string) => store.operations.find((row) => row.id === id)!.requestPayload as Record<string, unknown>;
const statusOf = (id: string) => store.operations.find((row) => row.id === id)!.status;

/** A $50 change A, unpaid and superseded by B, a $30 change carrying A's $50: an $80 request. */
function aSupersededByB(overrides: { a?: Partial<Row>; b?: Partial<Row> } = {}) {
  store.transactions.push(
    ask("a", { status: "FAILED", ...overrides.a }),
    ask("b", { amountCents: 8000, carriedAskCents: 5000, ...overrides.b }),
  );
  store.operations.push(waitingInvoice("mod_a", "pi_a", 5000), waitingInvoice("mod_b", "pi_b", 3000));
}

beforeEach(() => {
  store.payments = [{ id: "pay_1", bookingId: "booking_1" }];
  store.bookings = [{ id: "booking_1", status: "PAID", deletedAt: null }];
  store.transactions = [];
  store.operations = [];
  store.links = [];
  mocks.beforeOperationWrite.value = null;
  mocks.lockAnchor.mockReset();
  mocks.anchorCaptureHasReceipt.mockReset();
  mocks.anchorCaptureHasReceipt.mockResolvedValue(false);
  mocks.releaseForCapture.mockReset();
  mocks.releaseForCapture.mockResolvedValue({ released: 2, queueOperationIds: [], outcome: "released" });
});

describe("which request carries which (`carrierAndSupersededRows`)", () => {
  const row = (id: string, status: string, overrides: Partial<Row> = {}) =>
    ask(id, { status, ...overrides }) as Parameters<typeof carrierAndSupersededRows>[0][number] & Row;

  it("the newest live row carries the FAILED, unwithdrawn rows since the last capture", () => {
    const rows = [row("paid", "SUCCEEDED"), row("a1", "FAILED"), row("a2", "FAILED"), row("b", "PENDING")];
    const { carrier, superseded } = carrierAndSupersededRows(rows);
    expect(carrier?.id).toBe("txn_b");
    expect(superseded.map((r) => r.id)).toEqual(["txn_a1", "txn_a2"]);
  });

  it("a captured carrier still carries", () => {
    const { carrier, superseded } = carrierAndSupersededRows([row("a", "FAILED"), row("b", "SUCCEEDED")]);
    expect(carrier?.id).toBe("txn_b");
    expect(superseded.map((r) => r.id)).toEqual(["txn_a"]);
  });

  it.each([
    ["FAILED (declined, or itself superseded)", "FAILED", {}],
    ["withdrawn by a reduction", "PENDING", { withdrawnAt: new Date() }],
    ["refunded", "REFUNDED", {}],
  ])("nothing carries when the newest row is %s", (_label, status, overrides) => {
    const { carrier, superseded } = carrierAndSupersededRows([row("a", "FAILED"), row("b", status, overrides)]);
    expect(carrier).toBeNull();
    expect(superseded).toEqual([]);
  });

  it("a withdrawn row is a reduction's to account for, and a row before a capture was carried by it", () => {
    const rows = [
      row("before", "FAILED"),
      row("paid", "SUCCEEDED"),
      row("withdrawn", "FAILED", { withdrawnAt: new Date() }),
      row("b", "PENDING"),
    ];
    expect(carrierAndSupersededRows(rows).superseded).toEqual([]);
  });
});

describe("the move (`followSupersededAskInvoicesToCarrier`)", () => {
  it("moves A's waiting invoice onto B, each for its own amount, recording where it first waited", async () => {
    aSupersededByB();

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toEqual({ carrierPaymentIntentId: "pi_b", moved: 1, refusals: [], releasedOnCapturedCarrier: false });
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", parkedFromPaymentIntentId: "pi_a", priceDiffCents: 5000, recordPayment: true });
    expect(statusOf("op_mod_a")).toBe("WAITING_PAYMENT");
    // B's own invoice is untouched: never folded together.
    expect(payloadOf("op_mod_b")).toMatchObject({ paymentIntentId: "pi_b", priceDiffCents: 3000 });
    expect(payloadOf("op_mod_b")).not.toHaveProperty("parkedFromPaymentIntentId");
    expect(mocks.lockAnchor).toHaveBeenCalledTimes(1);
    expect(mocks.lockAnchor.mock.calls[0]![1]).toBe("mod_a");
    // B is not captured: nothing is released.
    expect(mocks.releaseForCapture).not.toHaveBeenCalled();
    // A reduction attributes it to A's own money.
    expect(supplementaryInvoiceWaitedFirstOn(payloadOf("op_mod_a"))).toBe("pi_a");
  });

  it("is idempotent: a replay finds nothing still waiting on a superseded intent", async () => {
    aSupersededByB();
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    const before = JSON.stringify(store.operations);

    const again = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(again.moved).toBe(0);
    expect(again.refusals).toEqual([]);
    expect(JSON.stringify(store.operations)).toBe(before);
  });

  it("moves along a chain A -> B -> C, keeping where each invoice first waited", async () => {
    aSupersededByB();
    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    // C supersedes B, carrying B's whole $80 on top of its own $20.
    store.transactions.find((row) => row.id === "txn_b")!.status = "FAILED";
    store.transactions.push(ask("c", { amountCents: 10000, carriedAskCents: 8000 }));
    store.operations.push(waitingInvoice("mod_c", "pi_c", 2000));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(2);
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_c", parkedFromPaymentIntentId: "pi_a" });
    expect(payloadOf("op_mod_b")).toMatchObject({ paymentIntentId: "pi_c", parkedFromPaymentIntentId: "pi_b" });
    expect(payloadOf("op_mod_c")).toMatchObject({ paymentIntentId: "pi_c" });
  });

  it("moves a DECLINED ask's invoice too: carried, though no cancel step ever runs for it", async () => {
    aSupersededByB();
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_b" });
    expect(result.moved).toBe(1);
  });

  it("releases at once when the carrier was already captured", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toMatchObject({ moved: 1, releasedOnCapturedCarrier: true });
    expect(mocks.releaseForCapture).toHaveBeenCalledWith("pi_b");
    // The capture's own receipt did not record it: the invoice still records its payment.
    expect(payloadOf("op_mod_a").recordPayment).toBe(true);
  });

  it("on a captured carrier whose own receipt records the capture, the moved invoice goes out unpaid (one recorder)", async () => {
    aSupersededByB({ b: { status: "SUCCEEDED" } });
    mocks.anchorCaptureHasReceipt.mockResolvedValue(true);

    await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(mocks.anchorCaptureHasReceipt).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "booking_1",
      bookingModificationId: "mod_a",
      paymentIntentId: "pi_b",
    });
    expect(payloadOf("op_mod_a")).toMatchObject({ paymentIntentId: "pi_b", recordPayment: false });
  });

  it("a carrier captured AFTER the move's own read is still released, read after the move commits", async () => {
    aSupersededByB();
    mocks.beforeOperationWrite.value = () => {
      store.transactions.find((row) => row.id === "txn_b")!.status = "SUCCEEDED";
    };

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.releasedOnCapturedCarrier).toBe(true);
    expect(mocks.releaseForCapture).toHaveBeenCalledWith("pi_b");
  });

  it("a currency re-issue: the change's OWN invoice follows its new intent, within its amount", async () => {
    // The stale intent and its re-issue in the club's currency: same edit, same
    // $50, nothing carried.
    store.transactions.push(ask("stale", { status: "FAILED", bookingModificationId: "mod_x" }), ask("new", { bookingModificationId: "mod_x" }));
    store.operations.push(waitingInvoice("mod_x", "pi_stale", 5000));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_new" });

    expect(result.moved).toBe(1);
    expect(payloadOf("op_mod_x")).toMatchObject({ paymentIntentId: "pi_new", parkedFromPaymentIntentId: "pi_stale" });
  });

  it("a review charge carrying A: its own change is read from its reason", async () => {
    aSupersededByB({ b: { bookingModificationId: null, reason: buildEditFinancialReviewChargeReason("mod_b") } });

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(1);
  });

  it("the bank-transfer route is a no-op: no card ask, so not even the outbox is read", async () => {
    store.transactions.push(
      ask("ib1", { source: "INTERNET_BANKING", status: "FAILED", stripePaymentIntentId: null }),
      ask("ib2", { source: "INTERNET_BANKING", stripePaymentIntentId: null }),
    );
    // Each change's invoice was queued unpaid when it was priced.
    store.operations.push(
      waitingInvoice("mod_ib1", "none", 5000, { status: "PENDING" }),
      waitingInvoice("mod_ib2", "none", 3000, { status: "PENDING" }),
    );
    const before = JSON.stringify(store.operations);

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result).toEqual({ carrierPaymentIntentId: null, moved: 0, refusals: [], releasedOnCapturedCarrier: false });
    expect(mocks.lockAnchor).not.toHaveBeenCalled();
    expect(JSON.stringify(store.operations)).toBe(before);
  });
});

describe("what it refuses, leaving the row exactly as it was", () => {
  async function refused(reason: string) {
    const before = JSON.stringify(payloadOf("op_mod_a"));
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    expect(result.refusals.map((refusal) => refusal.reason)).toEqual([reason]);
    expect(JSON.stringify(payloadOf("op_mod_a"))).toBe(before);
    expect(statusOf("op_mod_a")).toBe("WAITING_PAYMENT");
    expect(mocks.releaseForCapture).not.toHaveBeenCalled();
  }

  it.each(["CANCELLED", "BUMPED"])("a %s booking: nothing is asked of it", async (status) => {
    aSupersededByB();
    store.bookings[0]!.status = status;
    await refused("booking-ended");
  });

  it("a booking cancelled while the move waited on the anchor's key: refused under the key", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockImplementation(async () => {
      store.bookings[0]!.status = "CANCELLED";
    });
    await refused("booking-ended");
  });

  it("a newer request minted while the move waited on the key: the carrier changed, nothing moves", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockImplementation(async () => {
      store.transactions.find((row) => row.id === "txn_b")!.status = "FAILED";
      store.transactions.push(ask("c", { amountCents: 10000, carriedAskCents: 8000 }));
    });
    await refused("changed-under-lock");
  });

  it("a deleted booking", async () => {
    aSupersededByB();
    store.bookings[0]!.deletedAt = new Date();
    await refused("booking-ended");
  });

  it("a minter naming an intent that is no longer the newest request", async () => {
    aSupersededByB();
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1", carrierPaymentIntentId: "pi_older" });
    expect(result.refusals).toEqual([{ anchorId: null, reason: "not-the-carrier" }]);
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("no live carrier: the newest request was itself declined", async () => {
    aSupersededByB({ b: { status: "FAILED" } });
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result).toEqual({ carrierPaymentIntentId: null, moved: 0, refusals: [], releasedOnCapturedCarrier: false });
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("a reduction already withdrew A and retired its invoice: nothing to move", async () => {
    aSupersededByB({ a: { withdrawnAt: new Date() } });
    store.operations[0]!.status = "CANCELLED";
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    expect(mocks.lockAnchor).not.toHaveBeenCalled();
  });

  it("A's change already has a supplementary invoice in Xero", async () => {
    aSupersededByB();
    store.links.push({
      id: "link_1",
      localModel: "BookingModification",
      localId: "mod_a",
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    });
    await refused("invoice-already-linked");
  });

  it("another invoice for A's change is queued (the repair raised one)", async () => {
    aSupersededByB();
    store.operations.push({ ...waitingInvoice("mod_a", "none", 5000, { status: "PENDING" }), id: "op_repair" });
    await refused("another-invoice-queued");
  });

  it("B would bill more than it asks for", async () => {
    aSupersededByB({ b: { amountCents: 7000, carriedAskCents: 5000 } });
    await refused("carrier-would-overbill");
  });

  it("A's invoice is more than B carried, even where B's amount would hold it", async () => {
    aSupersededByB({ b: { amountCents: 9000, carriedAskCents: 4000 } });
    await refused("carrier-would-overbill");
  });

  it("nothing carried at all: an invoice on another change cannot move", async () => {
    aSupersededByB({ b: { amountCents: 9000, carriedAskCents: 0 } });
    await refused("carrier-would-overbill");
  });

  it("an unreadable invoice", async () => {
    aSupersededByB();
    (payloadOf("op_mod_a") as Record<string, unknown>).priceDiffCents = "fifty";
    await refused("unreadable-invoice");
  });

  it("an invoice an officer marked resolved, or one carrying an error code, is not a candidate", async () => {
    aSupersededByB();
    store.operations[0]!.lastErrorCode = "PROVIDER_CAPTURED_UNRECORDED";
    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });
    expect(result.moved).toBe(0);
    store.operations[0]!.lastErrorCode = null;
    store.operations[0]!.manuallyResolvedAt = new Date();
    expect((await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" })).moved).toBe(0);
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });

  it("THE STATUS GUARD: a row a capture released or the reaper retired between read and write is not rewritten", async () => {
    aSupersededByB();
    mocks.beforeOperationWrite.value = () => {
      store.operations.find((row) => row.id === "op_mod_a")!.status = "CANCELLED";
    };
    const before = JSON.stringify(payloadOf("op_mod_a"));

    const result = await followSupersededAskInvoicesToCarrier({ paymentId: "pay_1" });

    expect(result.moved).toBe(0);
    expect(result.refusals).toEqual([{ anchorId: "mod_a", reason: "changed-under-lock" }]);
    expect(JSON.stringify(payloadOf("op_mod_a"))).toBe(before);
  });
});

describe("the callers' spelling (`followSupersededAskInvoicesSafely`)", () => {
  it("never throws: a failure is logged and answers null", async () => {
    aSupersededByB();
    mocks.lockAnchor.mockRejectedValue(new Error("connection reset"));
    await expect(followSupersededAskInvoicesSafely({ paymentId: "pay_1" })).resolves.toBeNull();
    expect(payloadOf("op_mod_a").paymentIntentId).toBe("pi_a");
  });
});
