import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const data = vi.hoisted(() => ({ modifications: [] as unknown[], tasks: [] as unknown[], links: [] as unknown[], operations: [] as unknown[] }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  bookingModification: { findMany: vi.fn(async () => data.modifications) },
  manualRefundTask: { findMany: vi.fn(async () => data.tasks) },
  xeroObjectLink: { findMany: vi.fn(async () => data.links) },
  xeroSyncOperation: { findMany: vi.fn(async () => data.operations) },
} }));
import { prisma } from "@/lib/prisma";
import { readBookingSupplementaryInvoiceIdentities } from "@/lib/booking-supplementary-invoice-identities";
import { observationReviewContext } from "./support/booking-observation-fixtures";
const stamp = new Date("2026-06-01T00:00:00Z");
function operation(localModel: string, localId: string, id: string | null, extra: Record<string, unknown> = {}) {
  return { id: `op-${localId}`, localModel, localId, entityType: "INVOICE", operationType: "CREATE", direction: "OUTBOUND", status: "SUCCEEDED",
    queueType: "SUPPLEMENTARY_INVOICE", requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: "booking", bookingModificationId: localModel === "Booking" ? undefined : "mod", shortfallReviewTaskId: localModel === "ManualRefundTask" ? localId : undefined, priceDiffCents: 100, changeFeeCents: 0, recordPayment: false },
    xeroObjectType: "INVOICE", xeroObjectId: id, xeroObjectNumber: "INV-1", xeroObjectUrl: null, correlationKey: null, idempotencyKey: null, createdAt: stamp, updatedAt: stamp, ...extra };
}
function link(localModel: string, localId: string, id: string, active = true) {
  return { localModel, localId, xeroObjectType: "INVOICE", xeroObjectId: id, xeroObjectNumber: "INV-1", xeroObjectUrl: null, role: "SUPPLEMENTARY_INVOICE", active, createdAt: stamp, updatedAt: stamp };
}
beforeEach(() => { data.modifications = [{ id: "mod" }]; data.tasks = []; data.links = []; data.operations = []; vi.clearAllMocks(); });
describe("complete supplementary display identity discovery", () => {
  it("reads Booking, modification and eligible second-ask anchors and deduplicates replay links", async () => {
    // The context uses the canonical parser's current version and required fields.
    data.tasks = [{ id: "task", reviewContext: observationReviewContext("booking", "mod") }];
    data.operations = [operation("Booking", "booking", "direct"), operation("BookingModification", "mod", "mod-invoice"), operation("ManualRefundTask", "task", "second")];
    data.links = [link("Booking", "booking", "direct"), link("BookingModification", "mod", "mod-invoice")];
    const result = await readBookingSupplementaryInvoiceIdentities("booking");
    expect(result.invoiceIds).toEqual(["direct", "mod-invoice", "second"]);
    expect(result.incomplete).toBe(false);
    expect(prisma.xeroObjectLink.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: "SUPPLEMENTARY_INVOICE" }) }));
  });
  it("recovers sent/PARTIAL IDs without links and retains all distinct replayed invoices", async () => {
    data.operations = [operation("BookingModification", "mod", "one", { status: "PARTIAL" }), operation("BookingModification", "mod", "two")];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).invoiceIds).toEqual(["one", "two"]);
  });
  it("excludes card receipts even if their Xero payment-recording leg failed", async () => {
    const op = operation("BookingModification", "mod", "receipt");
    data.operations = [{ ...op, status: "PARTIAL", requestPayload: { ...op.requestPayload, recordPayment: true } }];
    data.links = [link("BookingModification", "mod", "receipt")];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
  });
  it("marks unissued, inactive, owner-mismatched and unknown provenance honestly", async () => {
    data.operations = [operation("BookingModification", "mod", null, { status: "PENDING" })];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: true });
    data.operations = [];
    data.links = [link("BookingModification", "mod", "inactive", false)];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).incomplete).toBe(true);
    data.links = [link("BookingModification", "mod", "unknown")];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: true });
    const op = operation("BookingModification", "mod", "wrong");
    data.operations = [{ ...op, requestPayload: { ...op.requestPayload, bookingId: "someone-else" } }];
    expect((await readBookingSupplementaryInvoiceIdentities("booking")).invoiceIds).toEqual([]);
  });
  it("does not recover an unrelated primary/group invoice from a shared Booking anchor", async () => {
    data.operations = [operation("Booking", "booking", "primary", { queueType: "BOOKING_INVOICE" }), operation("Booking", "booking", "group", { queueType: "GROUP_SETTLEMENT_INVOICE" })];
    expect(await readBookingSupplementaryInvoiceIdentities("booking")).toMatchObject({ invoiceIds: [], incomplete: false });
  });
});
