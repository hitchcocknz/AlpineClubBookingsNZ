import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  auditIbSettledCash,
  formatIbSettledCashReport,
  recordedInvoiceCash,
} from "@/lib/ib-settled-cash-audit";

/**
 * #3979 (`INV-PAY-124`): the read-only report of settled bank-transfer receipts
 * whose figure is not the cash Xero recorded. Report only; nothing is written.
 */
function link(localId: string, invoiceId: string, amount: unknown, status = "AUTHORISED") {
  return { localId, xeroObjectType: "PAYMENT", role: "INVOICE_PAYMENT", metadata: { invoiceId, amount, status } };
}

describe("recordedInvoiceCash", () => {
  it("sums the invoice's recorded payments, leaving out DELETED ones and other invoices", () => {
    expect(
      recordedInvoiceCash(
        [link("p", "inv", 120), link("p", "inv", 80), link("p", "inv", 50, "DELETED"), link("p", "other", 999)],
        "inv",
      ),
    ).toEqual({ evidence: "payments", cashCents: 20_000 });
  });

  it("says when nothing is recorded, or a figure cannot be read", () => {
    expect(recordedInvoiceCash([], "inv")).toEqual({ evidence: "none", cashCents: null });
    expect(recordedInvoiceCash([link("p", "inv", "120.00")], "inv")).toEqual({ evidence: "unreadable", cashCents: null });
  });
});

describe("auditIbSettledCash", () => {
  function db(payments: unknown[], links: unknown[]) {
    const paymentFindMany = vi.fn().mockResolvedValue(payments);
    const linkFindMany = vi.fn().mockResolvedValue(links);
    return {
      store: { payment: { findMany: paymentFindMany }, xeroObjectLink: { findMany: linkFindMany } } as never,
      paymentFindMany,
      linkFindMany,
    };
  }
  const receipt = (id: string, recordedCents: number) => ({
    id,
    bookingId: `b-${id}`,
    amountCents: recordedCents,
    booking: { status: "PAID" },
    transactions: [{ amountCents: recordedCents, xeroInvoiceId: `inv-${id}`, xeroInvoiceNumber: `INV-${id}` }],
  });

  it("lists a stale receipt, passes one that matches, and lists apart one it cannot judge", async () => {
    const { store, paymentFindMany } = db(
      [receipt("stale", 30_000), receipt("fine", 20_000), receipt("overpaid-by-allocation", 20_000)],
      [link("stale", "inv-stale", 200), link("fine", "inv-fine", 200)],
    );

    const result = await auditIbSettledCash(store);

    expect(result.scanned).toBe(3);
    expect(result.differences).toEqual([
      expect.objectContaining({ paymentId: "stale", recordedCents: 30_000, cashCents: 20_000, evidence: "payments" }),
    ]);
    expect(result.unjudged).toEqual([expect.objectContaining({ paymentId: "overpaid-by-allocation", evidence: "none" })]);
    // Only bank-transfer payments not settled by hand, on a captured PRIMARY receipt.
    expect(paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ source: "INTERNET_BANKING", manuallyMarkedPaidAt: null }),
      }),
    );

    const report = formatIbSettledCashReport(result, CLUB_FORMAT_TEST);
    expect(report).toContain("recorded figure differs from the cash: 1");
    expect(report).toContain("booking b-stale (PAID) payment stale invoice INV-stale: recorded $300.00, cash $200.00");
    expect(report).toContain("no payment recorded locally");
  });

  it("reads no links when there is nothing to judge", async () => {
    const { store, linkFindMany } = db([], []);
    expect(await auditIbSettledCash(store)).toEqual({ scanned: 0, differences: [], unjudged: [] });
    expect(linkFindMany).not.toHaveBeenCalled();
  });
});
