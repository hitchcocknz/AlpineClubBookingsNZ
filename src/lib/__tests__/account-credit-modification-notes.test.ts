import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { xeroSyncOperation: { findMany } } }));

import { noCashModificationNoteIds } from "@/lib/xero-inbound/account-credit-modification-notes";
import { UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";

/**
 * Which modification credit notes moved no cash, so never fold into a
 * payment's refunded total. #3979 (`INV-PAY-124`) adds the invoice correction
 * (`INV-PAY-116`) beside #3809's account-credit wording and #3954's
 * billed-offset scope. Read from the wording the note's operation recorded
 * when it was raised.
 */
function operation(xeroObjectId: string, requestPayload: Record<string, unknown>) {
  return { xeroObjectId, requestPayload };
}

describe("noCashModificationNoteIds (#3809, #3954, #3979)", () => {
  beforeEach(() => findMany.mockReset());

  it("an invoice correction moved no cash; a refund by any method did", async () => {
    findMany.mockResolvedValue([
      operation("cn-correction", { refundAmountCents: 10_000, noteWording: "invoice-correction" }),
      operation("cn-bank", { refundAmountCents: 10_000, refundMethod: "internet-banking" }),
      operation("cn-card", { refundAmountCents: 10_000, refundMethod: "card" }),
      operation("cn-cash", { refundAmountCents: 10_000, refundMethod: "internet-banking", noteWording: "cash" }),
      operation("cn-credit", { refundAmountCents: 10_000, refundMethod: "account-credit" }),
      operation("cn-offset", { refundAmountCents: 10_000, reviewTaskId: UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE }),
      operation("cn-legacy", { refundAmountCents: 10_000 }),
    ]);

    const ids = await noCashModificationNoteIds([
      "cn-correction",
      "cn-bank",
      "cn-card",
      "cn-cash",
      "cn-credit",
      "cn-offset",
      "cn-legacy",
    ]);

    expect([...ids].sort()).toEqual(["cn-correction", "cn-credit", "cn-offset"]);
  });

  it("a clearing note is not a modification note's wording and stays as it was", async () => {
    findMany.mockResolvedValue([
      operation("cn-clearing", { refundAmountCents: 10_000, clearsUnpaidInvoice: true, noteWording: "invoice-correction" }),
    ]);

    // `readModificationNoteWording` reads a clearing note as clearing only,
    // never with a wording beside it.
    expect(await noCashModificationNoteIds(["cn-clearing"])).toEqual(new Set());
  });

  it("asks nothing for no notes", async () => {
    expect(await noCashModificationNoteIds([])).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });
});
