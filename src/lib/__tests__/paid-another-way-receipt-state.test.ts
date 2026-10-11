import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3924 rounds 11 and 12 (`INV-PAY-122`): what the repair tool's record-by-hand
 * finding for a refund closed as paid another way names - the capture's own
 * card refunds (`PaymentRefund` rows by intent) less the refund notes naming
 * the capture, plus what the close paid back. Never the capture row's
 * `refundedAmountCents`, which also carries any other hand-back allocated to
 * it. Read only when the paid-another-way verdict says the receipt was
 * resolved by hand. The card-refund reader is the real one, over a stubbed
 * store. Round 13: only a card note that reached Xero is taken off.
 */
const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  close: vi.fn(),
  capture: vi.fn(),
  refunds: vi.fn(),
  notes: vi.fn(),
  noteRows: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: { findUnique: async () => ({ id: "task_late", paymentId: "payment_1" }) },
    xeroObjectLink: { findMany: async () => [] },
    xeroSyncOperation: {
      count: (...a: unknown[]) => mocks.noteRows(...a),
      findMany: (...a: unknown[]) => mocks.notes(...a),
    },
    paymentTransaction: { findFirst: (...a: unknown[]) => mocks.capture(...a) },
    paymentRefund: { findMany: (...a: unknown[]) => mocks.refunds(...a) },
  },
}));
vi.mock("@/lib/late-capture-xero-receipt", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-xero-receipt")),
  readPaidAnotherWayLateCaptureXeroReceipt: (...a: unknown[]) => mocks.receipt(...a),
}));
vi.mock("@/lib/late-capture-paid-another-way", () => ({
  findLateCaptureRefundPaidAnotherWay: (...a: unknown[]) => mocks.close(...a),
}));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn() }));
vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({ lockKeptLateCaptureTask: vi.fn() }));

import { readPaidAnotherWayReceiptState } from "@/lib/paid-another-way-receipt-note";
import {
  readUnnotedLateCaptureCardRefundCents,
  sumLateCaptureNotedCents,
} from "@/lib/late-capture-refund-credit-note";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";

const cardNote = (amountCents: number) => ({
  status: "SUCCEEDED",
  xeroObjectId: "cn_card",
  manuallyResolvedAt: null,
  requestPayload: { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, refundAmountCents: amountCents, paymentIntentId: "pi_late" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.receipt.mockResolvedValue({ kind: "resolved-by-hand" });
  mocks.close.mockResolvedValue({ id: "close_1", paymentId: "payment_1", amountCents: 6000 });
  mocks.noteRows.mockResolvedValue(0);
  // The capture row: 4000 to the card, 6000 closed as paid another way, and a
  // later 5000 hand-back that landed on the same row.
  mocks.capture.mockResolvedValue({ refundedAmountCents: 15000 });
  mocks.refunds.mockResolvedValue([
    { amountCents: 4000, status: "succeeded", stripeCreatedAt: null, createdAt: new Date("2026-06-20T00:00:00Z") },
  ]);
  mocks.notes.mockResolvedValue([cardNote(1000)]);
});

describe("readPaidAnotherWayReceiptState: recordByHandCents (rounds 11 and 12)", () => {
  it("MUTATION: round 12: is the capture's own card refunds less the notes naming it, plus the close - never a later hand-back on the capture row", async () => {
    const state = await readPaidAnotherWayReceiptState("pi_late");
    // 4000 card - 1000 noted + 6000 closed; the 5000 hand-back is not the capture's.
    expect(state).toMatchObject({ close: { id: "close_1", amountCents: 6000 }, noteAsked: false, recordByHandCents: 9000 });
    expect(mocks.receipt).toHaveBeenCalledWith("pi_late");
    expect(mocks.refunds).toHaveBeenCalledWith(
      expect.objectContaining({ where: { paymentId: "payment_1", stripePaymentIntentId: "pi_late" } }),
    );
    expect(mocks.notes).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ localId: "payment_1", requestPayload: { path: ["paymentIntentId"], equals: "pi_late" } }),
      }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("counts only succeeded card refunds, and never takes a card note below nothing off the close", async () => {
    mocks.refunds.mockResolvedValue([
      { amountCents: 4000, status: "failed", stripeCreatedAt: null, createdAt: new Date() },
      { amountCents: 2000, status: "succeeded", stripeCreatedAt: null, createdAt: new Date() },
    ]);
    // 2000 succeeded - 1000 noted + 6000 closed; the failed 4000 never counts.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 7000 });
    mocks.notes.mockResolvedValue([cardNote(12000)]);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 6000 });
    mocks.refunds.mockResolvedValue([]);
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 6000 });
  });

  it("is nothing for a receipt the app recorded: its note follows", async () => {
    mocks.receipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_kept" });
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 0 });
    expect(mocks.refunds).not.toHaveBeenCalled();
  });
});

/**
 * #3924 round 13 (F1, `INV-PAY-122`): once the receipt is resolved by hand, a
 * card note that never reached Xero - queued, or FAILED while it waited for
 * the receipt - completes as skipped when it next runs, so it answers nothing
 * and its cents are recorded by hand. Only a note with its Xero credit note,
 * or one resolved by hand in Xero, is taken off. The note writer's own ask is
 * sized the other way: a queued or failed note is not asked for again.
 */
describe("round 13: only a card note in Xero is taken off what is recorded by hand", () => {
  /** A card note that FAILED while it waited for the receipt: never in Xero. */
  const waitingNote = (amountCents: number) => ({ ...cardNote(amountCents), status: "FAILED", xeroObjectId: null });

  it("MUTATION: card only - a FAILED waiting card note is still recorded by hand", async () => {
    mocks.notes.mockResolvedValue([waitingNote(1000)]);
    await expect(readUnnotedLateCaptureCardRefundCents("payment_1", "pi_late")).resolves.toBe(4000);
    // Beside one in Xero, only that one comes off.
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), { ...waitingNote(700), status: "PENDING" }]);
    await expect(readUnnotedLateCaptureCardRefundCents("payment_1", "pi_late")).resolves.toBe(3000);
  });

  it("MUTATION: card only - a card note resolved by hand in Xero is taken off", async () => {
    mocks.notes.mockResolvedValue([{ ...waitingNote(1500), manuallyResolvedAt: new Date("2026-06-21T00:00:00Z") }]);
    await expect(readUnnotedLateCaptureCardRefundCents("payment_1", "pi_late")).resolves.toBe(2500);
  });

  it("MUTATION: split - the close's finding names the FAILED waiting card note's cents with the close", async () => {
    mocks.notes.mockResolvedValue([waitingNote(1000)]);
    // 4000 card, none in Xero, + 6000 closed.
    await expect(readPaidAnotherWayReceiptState("pi_late")).resolves.toMatchObject({ recordByHandCents: 10000 });
  });

  it("MUTATION: the note writer's own ask still counts a queued or failed note, so it is never asked for twice", async () => {
    mocks.notes.mockResolvedValue([cardNote(1000), waitingNote(500), { ...waitingNote(700), status: "PENDING" }]);
    await expect(sumLateCaptureNotedCents("payment_1", "pi_late")).resolves.toBe(2200);
    await expect(sumLateCaptureNotedCents("payment_1", "pi_late", { inXeroOnly: true })).resolves.toBe(1000);
  });
});
