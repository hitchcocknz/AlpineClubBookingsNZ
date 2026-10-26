import { beforeEach, describe, expect, it, vi } from "vitest";

// #4095 items 5 and 12 (`INV-PAY-126`): a bank-transfer settle that keeps the
// stored figure recounts the invoice corrections already synced against it.
// The realdb suite (`ib-settle-from-cash.realdb.test.ts`) drives the whole
// settle; this pins which notes are recounted, and with what.

const mocks = vi.hoisted(() => ({
  linkFindFirst: vi.fn(),
  repair: vi.fn(),
  resolve: vi.fn(),
  readModificationNoteCash: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { xeroObjectLink: { findFirst: mocks.linkFindFirst } } }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/xero-inbound/credit-note-repairs", () => ({ repairRefundedPaymentBusinessState: mocks.repair }));
vi.mock("@/lib/xero-inbound/modification-note-refunds", () => ({
  resolveModificationRefundAmountsByPaymentId: mocks.resolve,
}));
vi.mock("@/lib/xero-inbound/account-credit-modification-notes", () => ({
  readModificationNoteCash: mocks.readModificationNoteCash,
}));

import { recountCorrectionsAfterKeptSettle } from "@/lib/xero-inbound/kept-settle-correction-recount";
import { decideInternetBankingReceiptFigure } from "@/lib/xero-inbound/settle-from-cash";

const INVOICE_ID = "inv-4095";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkFindFirst.mockResolvedValue({ metadata: { status: "AUTHORISED", total: 100 } });
  mocks.resolve.mockResolvedValue(new Map([["pay-1", 10_000]]));
  mocks.repair.mockResolvedValue({ matchedPaymentIds: ["pay-1"], changedPaymentIds: ["pay-1"] });
});

describe("recountCorrectionsAfterKeptSettle (#4095 items 5 and 12)", () => {
  it("recounts a synced correction as its own sync does: its contribution by invoice, then the repair", async () => {
    await recountCorrectionsAfterKeptSettle(INVOICE_ID, [{ id: "note-1", appliedCents: 10_000 }]);

    expect(mocks.linkFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ xeroObjectType: "CREDIT_NOTE", xeroObjectId: "note-1", role: "MODIFICATION_CREDIT_NOTE", active: true }),
      }),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({
      creditNoteId: "note-1",
      isModificationNote: true,
      allocationTargets: [{ invoiceId: INVOICE_ID, amountCents: 10_000 }],
    });
    expect(mocks.repair).toHaveBeenCalledTimes(1);
    const input = mocks.repair.mock.calls[0][0];
    expect(input).toMatchObject({
      creditNoteId: "note-1",
      creditNote: { status: "AUTHORISED", total: 100 },
      directPaymentIds: [],
      modificationRefundAmountsByPaymentId: new Map([["pay-1", 10_000]]),
    });
    // The repair's retry re-resolves the contribution, as the note's own sync does.
    await input.recomputeModificationRefundAmounts();
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
  });

  it("leaves a note never synced to its own sync", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    await recountCorrectionsAfterKeptSettle(INVOICE_ID, [{ id: "note-1", appliedCents: 10_000 }]);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("never recounts a voided note", async () => {
    mocks.linkFindFirst.mockResolvedValue({ metadata: { status: "VOIDED", total: 100 } });
    await recountCorrectionsAfterKeptSettle(INVOICE_ID, [{ id: "note-1", appliedCents: 10_000 }]);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("skips a note whose contribution reaches no payment", async () => {
    mocks.resolve.mockResolvedValue(new Map());
    await recountCorrectionsAfterKeptSettle(INVOICE_ID, [{ id: "note-1", appliedCents: 10_000 }]);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("never fails the committed settle: a failed or lost recount is logged and the next note still runs", async () => {
    mocks.repair
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ matchedPaymentIds: ["pay-1"], changedPaymentIds: [], unsettledPaymentIds: ["pay-1"] });
    await expect(
      recountCorrectionsAfterKeptSettle(INVOICE_ID, [
        { id: "note-1", appliedCents: 10_000 },
        { id: "note-2", appliedCents: 5_000 },
      ]),
    ).resolves.toBeUndefined();
    expect(mocks.repair).toHaveBeenCalledTimes(2);
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });
});

describe("decideInternetBankingReceiptFigure names the applied corrections (#4095)", () => {
  it("returns only the correction notes, never a refund-worded, no-cash or member-credit note", async () => {
    mocks.readModificationNoteCash.mockResolvedValue(
      new Map([
        ["correction", "correction"],
        ["refund", "refund"],
        ["no-cash", "no-cash"],
        ["member-credit", "correction"],
      ]),
    );
    const tx = {
      paymentTransaction: {
        findMany: vi.fn().mockResolvedValue([
          { kind: "PRIMARY", source: "INTERNET_BANKING", status: "PENDING", amountCents: 30_000, refundedAmountCents: 0 },
        ]),
      },
      memberCredit: { findMany: vi.fn().mockResolvedValue([{ xeroCreditNoteId: "member-credit" }]) },
    };
    const decided = await decideInternetBankingReceiptFigure(tx as never, {
      payment: { id: "pay-1", amountCents: 30_000, refundedAmountCents: 0 },
      cash: { knownCents: 20_000, complete: false },
      matchedPayments: 1,
      secondInstrument: false,
      invoice: {
        totalCents: 30_000,
        appliedCreditNotes: [
          { id: "correction", appliedCents: 10_000 },
          { id: "refund", appliedCents: 1_000 },
          { id: "no-cash", appliedCents: 2_000 },
          { id: "member-credit", appliedCents: 3_000 },
        ],
      },
    });
    expect(decided.plan).toMatchObject({ kind: "keep" });
    expect(decided.appliedCorrectionNotes).toEqual([{ id: "correction", appliedCents: 10_000 }]);
  });
});
