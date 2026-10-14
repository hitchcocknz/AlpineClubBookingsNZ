// #4104 review (money 2 and 3): what a "Paid another way" close of a card
// refund that Stripe failed later records in Xero. Its card refund note was
// raised while the refund counted, so while that note stands a bank note would
// credit the invoice twice; and a late capture's refund keeps INV-PAY-110's
// routing whichever row owes it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coveredCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  unreadable: vi.fn((): string[] => []),
  eligibleCashCents: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  lateCaptureIntent: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
  receipt: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ kind: "recorded", invoiceId: "inv-receipt" })),
  enqueueNote: vi.fn<(...args: unknown[]) => Promise<{ queueOperationId: string }>>(async () => ({ queueOperationId: "xop-1" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0, unreadableOperationIds: mocks.unreadable() }),
  sumRefundCreditNoteCoverageCents: (...args: unknown[]) => mocks.coveredCents(...args),
}));
vi.mock("@/lib/refund-note-eligible-cash", () => ({
  resolveRefundNoteEligibleCash: async (...args: unknown[]) => ({ eligibleCashCents: await mocks.eligibleCashCents(...args) }),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  lateCaptureIntentOfCardRefundOperation: (...args: unknown[]) => mocks.lateCaptureIntent(...args),
}));
vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findKeptLateCaptureInvoiceIdForPayment: async () => null,
  readPaidAnotherWayLateCaptureXeroReceipt: (...args: unknown[]) => mocks.receipt(...args),
}));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  keptLateCaptureDocumentDate: () => "2026-06-19",
  lockKeptLateCaptureTask: vi.fn(),
}));
vi.mock("@/lib/kept-late-capture-receipt-rows", () => ({ keptReceiptHeldForOfficer: async () => false }));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: (...args: unknown[]) => mocks.enqueueNote(...args) }));

import {
  paidAnotherWayXeroPlan,
  paidAnotherWayXeroPromise,
  queuePaidAnotherWayXero,
} from "@/lib/card-refund-paid-another-way-xero";
import { xeroQueuedMessage, xeroRefundNotePromise } from "@/components/admin/dead-card-refunds-xero-copy";

const db = {
  payment: { findUnique: vi.fn(async () => ({ id: "p-1", bookingId: "b-1", refundedAmountCents: 0 })) },
  manualRefundTask: { findUnique: vi.fn(async () => null) },
};
const PAYMENT = { id: "p-1", xeroInvoiceId: "inv-1" };
const failedLater = { idempotencyKey: "card_refund_failed_later_re_1", paymentIntentId: "pi_1", amountCents: 4_000 };
const plan = (operation = failedLater) => paidAnotherWayXeroPlan(db as never, operation, PAYMENT, { lockApprovalTask: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unreadable.mockReturnValue([]);
  mocks.coveredCents.mockResolvedValue(0);
  mocks.eligibleCashCents.mockResolvedValue(0);
  mocks.lateCaptureIntent.mockResolvedValue(null);
});

describe("a failed-later row closed as paid another way (#4104, money 2)", () => {
  it("MUTATION: while its card note still covers it - notes exceed the card cash by at least the refund - no second note", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    const xeroPlan = await plan();
    expect(xeroPlan).toEqual({ xeroRefundNote: "none", coveredByCardNote: true });
    expect(paidAnotherWayXeroPromise(xeroPlan)).toBe("covered-by-card-note");
    expect(await queuePaidAnotherWayXero({} as never, xeroPlan, {} as never)).toBe("covered-by-card-note");
    expect(mocks.enqueueNote).not.toHaveBeenCalled();
    expect(xeroRefundNotePromise("covered-by-card-note", "Bank transfer")).toMatch(/already holds this refund's card refund credit note/);
    expect(xeroQueuedMessage("covered-by-card-note", "Bank transfer")).toMatch(/already in Xero records this refund/);
  });

  it("with no card note left over for it (never raised, or credited back), the bank note is queued as for any close", async () => {
    mocks.coveredCents.mockResolvedValue(6_000);
    mocks.eligibleCashCents.mockResolvedValue(6_000);
    expect(await plan()).toEqual({ xeroRefundNote: "now" });
    mocks.coveredCents.mockResolvedValue(9_999);
    expect(await plan()).toEqual({ xeroRefundNote: "now" });
  });

  it("decides nothing on an unreadable note resolved by hand: the note's own enqueue refuses on it", async () => {
    mocks.unreadable.mockReturnValue(["xop-resolved"]);
    mocks.coveredCents.mockResolvedValue(10_000);
    expect(await plan()).toEqual({ xeroRefundNote: "now" });
  });

  it("any other row is never read for it", async () => {
    mocks.coveredCents.mockResolvedValue(10_000);
    expect(await plan({ idempotencyKey: "booking_cancel_refund_recovery_b-1", paymentIntentId: "pi_1", amountCents: 4_000 })).toEqual({ xeroRefundNote: "now" });
    expect(mocks.coveredCents).not.toHaveBeenCalled();
  });
});

describe("a late capture's refund that failed later keeps INV-PAY-110's routing (#4104, money 3)", () => {
  it("MUTATION: its note credits the capture's own receipt, read off the row's intent", async () => {
    mocks.lateCaptureIntent.mockResolvedValue("pi_late");
    expect(await plan({ ...failedLater, paymentIntentId: "pi_late" })).toEqual({ xeroRefundNote: "now", creditsInvoiceId: "inv-receipt" });
    expect(mocks.lateCaptureIntent).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "card_refund_failed_later_re_1", paymentIntentId: "pi_late" }), db);
    expect(mocks.receipt).toHaveBeenCalledWith("pi_late", db);
  });
});
