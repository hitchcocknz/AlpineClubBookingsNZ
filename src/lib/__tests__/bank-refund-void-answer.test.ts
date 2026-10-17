/**
 * #4162 (`INV-ADDPAY-042`): the "Yes, I already recorded it in Xero myself"
 * check, against a mocked Xero, and the follow-up's copy leaf. The provider
 * read happens before any transaction (the route calls it); refusals are plain
 * English and say why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCreditNotes = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: { getCreditNotes } }, tenantId: "tenant" })),
  callXeroApi: vi.fn((call: () => unknown) => call()),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { manualRefundTask: { findUnique } } }));

const { prepareBankRefundVoidAnswer, verifyHandMadeRefundNote } = await import("@/lib/bank-refund-void-answer");
const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
const copy = await import("@/lib/bank-refund-void-follow-up-copy");

const live = { creditNoteID: "cn-hand", creditNoteNumber: "CN-0123", status: "AUTHORISED", type: "ACCRECCREDIT", total: 200 };
const verify = (number = "CN-0123") => verifyHandMadeRefundNote({ creditNoteNumber: number, expectedAmountCents: 20_000, format: CLUB_FORMAT_TEST });

describe("verifyHandMadeRefundNote (#4162)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds the note by its number and accepts a live sales note for the amount", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [live] } });
    await expect(verify(" CN-0123 ")).resolves.toEqual({ creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, status: "AUTHORISED", total: 200 });
    expect(getCreditNotes).toHaveBeenCalledWith("tenant", undefined, 'CreditNoteNumber=="CN-0123"');
  });

  it.each([
    [[], "Xero has no credit note numbered CN-0123"],
    [[{ ...live, total: 150 }], "is for $150.00 in Xero, not $200.00"],
    [[{ ...live, status: "VOIDED" }], "is voided in Xero"],
    [[{ ...live, status: "DELETED" }], "is deleted in Xero"],
    [[{ ...live, type: "ACCPAYCREDIT" }], "is not a sales credit note"],
    [[live, { ...live, creditNoteID: "cn-other" }], "more than one credit note numbered"],
  ])("refuses %j with a reason", async (notes, reason) => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: notes } });
    await expect(verify()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(reason) });
  });

  it("refuses a number Xero's filter cannot take, before calling Xero", async () => {
    await expect(verify('CN-1" OR 1==1')).rejects.toMatchObject({ status: 400 });
    expect(getCreditNotes).not.toHaveBeenCalled();
  });

  it("says Xero could not be reached rather than guessing", async () => {
    getCreditNotes.mockRejectedValue(new Error("network"));
    await expect(verify()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("could not reach Xero") });
  });

  it("prepares the answer only for a follow-up, at its own amount", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [live] } });
    findUnique.mockResolvedValue({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: "bank-refund-void:pay-1:cn-1",
      amountCents: 20_000,
      reviewContext: copy.bankRefundVoidFollowUpReviewContext({
        voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: "CN-1", voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
      }),
    });
    await expect(
      prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" }, format: CLUB_FORMAT_TEST }),
    ).resolves.toMatchObject({ answer: "recorded-in-xero", note: { creditNoteId: "cn-hand" } });

    findUnique.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "edit-refund-hand-back:m", amountCents: 20_000, reviewContext: null });
    await expect(
      prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" }, format: CLUB_FORMAT_TEST }),
    ).rejects.toMatchObject({ status: 400 });
    // A fresh note needs no provider call at all.
    getCreditNotes.mockClear();
    await expect(prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "fresh-note" }, format: CLUB_FORMAT_TEST })).resolves.toEqual({ answer: "fresh-note" });
    expect(getCreditNotes).not.toHaveBeenCalled();
  });
});

describe("the follow-up's copy (#4162)", () => {
  it("round-trips the context it stores, and refuses a partial one", () => {
    const context = {
      voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: null, voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
    };
    expect(copy.readBankRefundVoidFollowUpContext(copy.bankRefundVoidFollowUpReviewContext(context))).toEqual(context);
    expect(copy.readBankRefundVoidFollowUpContext({ bankRefundVoidFollowUp: { voidedCreditNoteId: "cn-1" } })).toBeNull();
    expect(copy.readBankRefundVoidFollowUpContext(null)).toBeNull();
  });

  it("asks the owner's one question", () => {
    expect(
      copy.bankRefundVoidQuestion({ bookingReference: "B-123", amount: "$200.00", memberName: "Sam Lee", creditNoteNumber: "CN-0456", voidedOn: "14 Oct 2026" }),
    ).toBe("Booking B-123: $200.00 to Sam Lee. Its Xero credit note CN-0456 was voided on 14 Oct 2026, so it's back on this list. Has the $200.00 gone to the member?");
  });
});

describe("the refund list's payload marks a bank refund to re-confirm (#4162)", () => {
  it("carries the voided note's number and date, and never reads its context as unreadable review evidence", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "follow-up-1", bookingId: "booking-1", amountCents: 20_000, raisedAmountCents: 20_000, kind: "CANCELLED_BOOKING_HAND_BACK" as const,
      paymentId: "pay-1", payment: null, lateCaptureApprovalIntentId: null, partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null, partPaymentReviewXeroPaidCents: null,
      occurrenceKey: "bank-refund-void:pay-1:cn-1",
      reviewContext: copy.bankRefundVoidFollowUpReviewContext({
        voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: "CN-0456", voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
      }),
      reason: "r", createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"), member: { firstName: "Sam", lastName: "Lee" },
        organisation: null, memberId: "sam", deletedAt: null, status: "CANCELLED" as const, payment: null,
      },
    };
    expect(toOpenManualRefundTaskPayload(row as never, null, [])).toMatchObject({
      bankRefundVoidFollowUp: { voidedCreditNoteNumber: "CN-0456", voidedAt: "2026-06-30T00:00:00.000Z" },
      reviewEvidence: null,
      reviewEvidenceUnreadable: false,
      editRefundHandBack: false,
    });
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: "edit-refund-hand-back:m", reviewContext: null } as never, null, []).bankRefundVoidFollowUp).toBeNull();
  });
});
