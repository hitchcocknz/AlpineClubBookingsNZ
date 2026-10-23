/**
 * #3953 review round 1 (`INV-PAY-139`): one recorder per capture. The primary
 * invoice's create, the #3980 gap invoice, a change's own supplementary
 * invoice and a capture's own receipt each know which captures they record,
 * and every other writer stands down for those.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readPrimaryInvoiceFeeAtLink: vi.fn(),
  findPrimaryInvoiceGapInvoice: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-primary-invoice-gap-anchors", () => ({
  readPrimaryInvoiceFeeAtLink: mocks.readPrimaryInvoiceFeeAtLink,
  findPrimaryInvoiceGapInvoice: mocks.findPrimaryInvoiceGapInvoice,
}));

import { attributeGapCash, readCaptureRecorder } from "@/lib/additional-capture-recorder";
import { intentsRecordedByPrimaryCash } from "@/lib/xero-primary-invoice-fee-at-link";
import { primaryInvoiceGapPayload } from "@/lib/additional-capture-receipt-payload";

describe("intentsRecordedByPrimaryCash (F)", () => {
  const captures = [
    { paymentIntentId: "pi_primary", netCents: 30_000 },
    { paymentIntentId: "pi_change", netCents: 8_000 },
  ];

  it("covers the snapshot's captures oldest first, wholly, while the recorded cash lasts", () => {
    expect(intentsRecordedByPrimaryCash(captures, 38_000)).toEqual({ recorded: ["pi_primary", "pi_change"], partial: null });
  });

  it("MUTATION: a replay whose invoice Xero recorded at an earlier $300 covers only the booking's own capture", () => {
    expect(intentsRecordedByPrimaryCash(captures, 30_000)).toEqual({ recorded: ["pi_primary"], partial: null });
  });

  it("names the capture it reached part of, and how much", () => {
    expect(intentsRecordedByPrimaryCash(captures, 35_000)).toEqual({
      recorded: ["pi_primary"],
      partial: { paymentIntentId: "pi_change", cents: 5_000 },
    });
    expect(intentsRecordedByPrimaryCash(captures, 0)).toEqual({ recorded: [], partial: null });
  });
});

describe("attributeGapCash (A)", () => {
  const captures = [
    { paymentIntentId: "pi_primary", netCents: 30_000 },
    { paymentIntentId: "pi_change", netCents: 8_000 },
  ];

  it("pays the gap from the cash the primary left, naming the capture it came from", () => {
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 30_000, gapCents: 8_000 })).toEqual({
      leftoverCents: 8_000,
      covered: [{ paymentIntentId: "pi_change", cents: 8_000 }],
    });
  });

  it("MUTATION: never from a capture a receipt row claimed - then the gap is raised unpaid", () => {
    expect(attributeGapCash({ captures, claimed: new Set(["pi_change"]), primaryCashCents: 30_000, gapCents: 8_000 })).toEqual({
      leftoverCents: 0,
      covered: [],
    });
  });

  it("takes all of its figure or none, oldest first", () => {
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 30_000, gapCents: 9_000 }).covered).toEqual([]);
    expect(attributeGapCash({ captures, claimed: new Set(), primaryCashCents: 25_000, gapCents: 6_000 })).toEqual({
      leftoverCents: 13_000,
      covered: [
        { paymentIntentId: "pi_primary", cents: 5_000 },
        { paymentIntentId: "pi_change", cents: 1_000 },
      ],
    });
  });

  it("marks the gap's payload with what it took, so the names survive its send", () => {
    expect(primaryInvoiceGapPayload({ coveredCaptures: [{ paymentIntentId: "pi_change", cents: 8_000 }] })).toEqual({
      primaryInvoiceGap: true,
      coveredPaymentIntentIds: ["pi_change"],
      coveredCaptureCents: { pi_change: 8_000 },
    });
    expect(primaryInvoiceGapPayload(undefined)).toEqual({});
  });
});

describe("readCaptureRecorder (B, C)", () => {
  const store = {
    xeroSyncOperation: { findFirst: vi.fn() },
    xeroObjectLink: { findFirst: vi.fn() },
    bookingModification: {},
    manualRefundTask: {},
  };
  const input = { bookingId: "booking_1", primaryInvoiceId: "inv_primary", paymentIntentId: "pi_change", bookingModificationId: "mod_change" };
  const figures = { operationId: "op_primary", atLink: { xeroInvoiceId: "inv_primary", paymentIntentIdsRecordedAtLink: ["pi_primary"] } };
  const read = () => readCaptureRecorder(input, store as never);

  beforeEach(() => {
    vi.clearAllMocks();
    store.xeroSyncOperation.findFirst.mockResolvedValue(null);
    store.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue(figures);
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(null);
  });

  it("is the receipt where nothing else records the capture", async () => {
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap: null, gapBillsThisChange: false });
  });

  it("is a supplementary invoice naming the capture, or a gap invoice whose payment took it", async () => {
    store.xeroSyncOperation.findFirst.mockResolvedValueOnce({ id: "op_supp" });
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_supp" });
    expect(store.xeroSyncOperation.findFirst.mock.calls[0][0].where).toEqual({
      queueType: "SUPPLEMENTARY_INVOICE",
      status: { not: "CANCELLED" },
      OR: [
        { requestPayload: { path: ["paymentIntentId"], equals: "pi_change" } },
        { requestPayload: { path: ["coveredPaymentIntentIds"], array_contains: ["pi_change"] } },
      ],
    });
  });

  it("is the primary invoice where its recorded cash covered the capture", async () => {
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
      ...figures,
      atLink: { ...figures.atLink, paymentIntentIdsRecordedAtLink: ["pi_primary", "pi_change"] },
    });
    await expect(read()).resolves.toEqual({ kind: "primary-invoice" });
  });

  it("MUTATION: is the change's own supplementary invoice, whatever it records, where the gap does not bill that change", async () => {
    store.xeroSyncOperation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "op_change_invoice" });
    await expect(read()).resolves.toEqual({ kind: "supplementary-invoice", operationId: "op_change_invoice" });
    expect(store.xeroSyncOperation.findFirst.mock.calls[1][0].where).toMatchObject({
      localModel: "BookingModification",
      localId: "mod_change",
      status: { not: "CANCELLED" },
    });
  });

  it("is the receipt, against the gap invoice, where the capture's change is one the gap bills for", async () => {
    const gap = { operation: { id: "op_gap" }, link: { xeroObjectId: "inv_gap", active: true }, anchorIds: ["mod_change"] };
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gap);
    // The gap invoice is a supplementary invoice on the change; it is not the change's own.
    store.xeroSyncOperation.findFirst.mockResolvedValue(null);
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap, gapBillsThisChange: true });
  });

  it("is the receipt, against the primary, where the gap bills another change (C)", async () => {
    const gap = { operation: { id: "op_gap" }, link: { xeroObjectId: "inv_gap", active: true }, anchorIds: ["mod_racing"] };
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(gap);
    await expect(read()).resolves.toEqual({ kind: "receipt", figures, gap, gapBillsThisChange: false });
  });
});
