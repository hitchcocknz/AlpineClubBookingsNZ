import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
  CreditNoteSpentOutsideAppError,
  isCreditNoteOverAllocationText,
  namedXeroErrorCode,
} from "@/lib/xero-credit-note-spent-outside-app";
import { xeroRefusedOperation } from "@/lib/xero-error-shape";

/**
 * #4218 — when Xero refuses an allocation because the credit note was spent
 * outside the app, the operation records a named code and a plain reason.
 */

const mocks = vi.hoisted(() => ({
  getCreditNote: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroSyncOperation: { update: mocks.xeroSyncOperationUpdate } },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.test/invoice/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.test/credit-note/${id}`,
  stripXeroOrgShortCode: (url: string) => url,
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});
vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-client")),
  getAuthenticatedXeroClient: async () => ({
    xero: {
      accountingApi: {
        getCreditNote: mocks.getCreditNote,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
      },
    },
    tenantId: "tenant_1",
  }),
  callXeroApi: async (call: () => Promise<unknown>) => call(),
}));
vi.mock("@/lib/club-format-settings", async () => {
  const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
  return { getClubFormat: async () => CLUB_FORMAT_TEST };
});
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: async () => "Pacific/Auckland",
}));

import { allocateCreditNoteToInvoice } from "@/lib/xero-credit-notes";

const OVER_ALLOCATION_400 =
  "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";

function note(overrides: Record<string, unknown> = {}) {
  return { body: { creditNotes: [{ status: "PAID", remainingCredit: 0, ...overrides }] } };
}

describe("isCreditNoteOverAllocationText", () => {
  it("matches Xero's wording, in any case, and nothing else", () => {
    expect(isCreditNoteOverAllocationText(OVER_ALLOCATION_400)).toBe(true);
    expect(isCreditNoteOverAllocationText(OVER_ALLOCATION_400.toLowerCase())).toBe(true);
    expect(isCreditNoteOverAllocationText("Invoice is already paid")).toBe(false);
    expect(isCreditNoteOverAllocationText("")).toBe(false);
  });
});

describe("namedXeroErrorCode", () => {
  it("names only the dedicated error", () => {
    const error = new CreditNoteSpentOutsideAppError("x", "cn", 0, 5250);
    expect(namedXeroErrorCode(error)).toBe(CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE);
    expect(namedXeroErrorCode(new Error(OVER_ALLOCATION_400))).toBeNull();
  });
});

describe("xeroRefusedOperation", () => {
  it("counts the named code as a Xero refusal, as it counted the bare 400", () => {
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE })).toBe(true);
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: "400" })).toBe(true);
    expect(xeroRefusedOperation({ status: "FAILED", lastErrorCode: "429" })).toBe(false);
    expect(xeroRefusedOperation({ status: "SUCCEEDED", lastErrorCode: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE })).toBe(false);
  });
});

describe("allocateCreditNoteToInvoice — credit note spent outside the app (#4218)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
    mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  });

  it("sends the allocation without any read beforehand", async () => {
    await allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("turns Xero's over-allocation refusal into the named error, with the amount left", async () => {
    const original = new Error(OVER_ALLOCATION_400);
    mocks.createCreditNoteAllocation.mockRejectedValue(original);
    mocks.getCreditNote.mockResolvedValue(note({ remainingCredit: 0 }));

    const result = allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    await expect(result).rejects.toBeInstanceOf(CreditNoteSpentOutsideAppError);
    await expect(result).rejects.toMatchObject({
      code: CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE,
      remainingCents: 0,
      requestedCents: 5250,
      cause: original,
    });
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
    const [, recorded] = mocks.failXeroSyncOperation.mock.calls[0];
    expect(recorded).toBeInstanceOf(CreditNoteSpentOutsideAppError);
    expect((recorded as Error).message).toMatch(/only .* left in Xero; it was used outside the app/);
  });

  it("converts the real SDK refusal, which arrives as a JSON string", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(
      JSON.stringify({ response: { statusCode: 400, body: { Elements: [{ ValidationErrors: [{ Message: OVER_ALLOCATION_400 }] }] } } }),
    );
    mocks.getCreditNote.mockResolvedValue(note());

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBeInstanceOf(
      CreditNoteSpentOutsideAppError,
    );
  });

  it("still reports the named error, without an amount, when the follow-up read fails", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockRejectedValue(new Error("Xero is down"));

    const result = allocateCreditNoteToInvoice("cn_1", "inv_1", 5250);

    await expect(result).rejects.toMatchObject({ remainingCents: null });
    await expect(result).rejects.toThrow(/has less than this allocation needs left in Xero/);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBeInstanceOf(CreditNoteSpentOutsideAppError);
  });

  it("reports the named error when Xero returns no credit note on the follow-up read", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValue(new Error(OVER_ALLOCATION_400));
    mocks.getCreditNote.mockResolvedValue({ body: { creditNotes: [] } });

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toMatchObject({
      remainingCents: null,
    });
  });

  it("leaves every other Xero error exactly as it was", async () => {
    const other = new Error("Invoice is already paid");
    mocks.createCreditNoteAllocation.mockRejectedValue(other);

    await expect(allocateCreditNoteToInvoice("cn_1", "inv_1", 5250)).rejects.toBe(other);
    expect(mocks.failXeroSyncOperation.mock.calls[0][1]).toBe(other);
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
  });
});
