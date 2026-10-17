import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): the voided
 * bank-transfer refund note list's filters, the record-again note's key parts,
 * and the card self-heal's exclusion of bank transfers. Real-database proofs
 * of the same, and of the writers, are `bank-refund-void-resolution.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  paymentFindMany: vi.fn(),
  resolutionFindMany: vi.fn(),
  opFindFirst: vi.fn(),
  opFindMany: vi.fn(),
  resolutionFindFirst: vi.fn(),
  linkFindFirst: vi.fn(),
  blocking: vi.fn(),
  coverage: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-refund-note-link-repair", () => ({
  findBlockingRefundCreditNoteOperationId: mocks.blocking,
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  sumRefundCreditNoteCoverageOfRowsCents: mocks.coverage,
  isCoveredByExistingNoteRow: () => false,
}));

import { bankRefundVoidGraceThreshold, listBankRefundVoids } from "@/lib/bank-refund-void-report";
import { reRecordKeyParts, reRecordNoteRowsWhere } from "@/lib/bank-refund-re-record-note";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const OLD = new Date("2026-06-28T00:00:00.000Z");

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-v",
    localModel: "Payment",
    localId: "pay-1",
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: "cn-v",
    xeroObjectNumber: "CN-1",
    role: "REFUND_CREDIT_NOTE",
    active: false,
    metadata: { status: "VOIDED", amountCents: 20_000 },
    updatedAt: OLD,
    ...overrides,
  };
}

const db = {
  $queryRaw: mocks.queryRaw,
  xeroObjectLink: { findMany: mocks.linkFindMany, findFirst: mocks.linkFindFirst },
  payment: { findMany: mocks.paymentFindMany },
  bankRefundVoidResolution: { findMany: mocks.resolutionFindMany, findFirst: mocks.resolutionFindFirst },
  xeroSyncOperation: { findFirst: mocks.opFindFirst, findMany: mocks.opFindMany },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ id: "link-v" }]);
  mocks.linkFindMany.mockImplementation(async (args: { where: { active?: boolean } }) =>
    args.where.active === true ? [] : [link()],
  );
  mocks.paymentFindMany.mockResolvedValue([{ id: "pay-1", bookingId: "booking-1" }]);
  mocks.resolutionFindMany.mockResolvedValue([]);
  mocks.resolutionFindFirst.mockResolvedValue(null);
  mocks.opFindFirst.mockResolvedValue(null);
  mocks.opFindMany.mockResolvedValue([]);
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.blocking.mockResolvedValue(null);
  mocks.coverage.mockResolvedValue(0);
});

describe("which voided notes the list reads", () => {
  it("asks one statement for inactive refund-note links on bank transfers, recorded VOIDED or DELETED in any case, past the grace window", async () => {
    await listBankRefundVoids({ now: NOW, db });

    const [strings, ...values] = mocks.queryRaw.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain(`l."role" = 'REFUND_CREDIT_NOTE'`);
    expect(sql).toContain(`l."active" = false`);
    expect(sql).toContain(`upper(btrim(l."metadata"->>'status'))`);
    expect(sql).toContain(`p."source" = 'INTERNET_BANKING'`);
    expect(values[0]).toEqual(bankRefundVoidGraceThreshold(NOW));
    expect(bankRefundVoidGraceThreshold(NOW)).toEqual(new Date("2026-06-30T00:00:00.000Z"));
    expect(mocks.linkFindMany.mock.calls[0]![0].where).toEqual({ id: { in: ["link-v"] } });
  });

  it("keeps only bank-transfer payments, again in code", async () => {
    await listBankRefundVoids({ now: NOW, db });
    expect(mocks.paymentFindMany.mock.calls[0]![0].where).toEqual({ id: { in: ["pay-1"] }, source: "INTERNET_BANKING" });
  });

  it("MUTATION: re-checks each row's role, activity, status and age in code, so a looser query cannot widen the list", async () => {
    mocks.queryRaw.mockResolvedValue(["mod", "request", "active", "live", "fresh", "listed"].map((id) => ({ id })));
    mocks.linkFindMany.mockImplementation(async (args: { where: { active?: boolean } }) =>
      args.where.active === true
        ? []
        : [
            link({ id: "mod", role: "MODIFICATION_CREDIT_NOTE" }),
            link({ id: "request", role: "REFUND_REQUEST_CREDIT_NOTE" }),
            link({ id: "active", active: true }),
            link({ id: "live", metadata: { status: "AUTHORISED" } }),
            link({ id: "fresh", updatedAt: NOW }),
            link({ id: "listed" }),
          ],
    );
    const items = await listBankRefundVoids({ now: NOW, db });
    expect(items.map((item) => item.linkId)).toEqual(["listed"]);
    expect(items[0]).toMatchObject({ amountCents: 20_000, flag: null, reRecordRefusal: null, answerable: true });
  });

  it("leaves out a note already answered, and names why a record-again would be refused", async () => {
    mocks.resolutionFindMany.mockResolvedValue([
      { id: "r-1", paymentId: "pay-1", voidedCreditNoteId: "cn-v", outcome: "CONFIRMED_CANCELLED", amountCents: 20_000, noteOperationId: null },
    ]);
    expect(await listBankRefundVoids({ now: NOW, db })).toEqual([]);

    mocks.resolutionFindMany.mockResolvedValue([]);
    mocks.blocking.mockResolvedValue("op-running");
    expect((await listBankRefundVoids({ now: NOW, db }))[0]).toMatchObject({ reRecordRefusal: "note-in-flight" });

    mocks.linkFindMany.mockImplementation(async (args: { where: { active?: boolean } }) =>
      args.where.active === true ? [] : [link({ metadata: { status: "VOIDED" } })],
    );
    expect((await listBankRefundVoids({ now: NOW, db }))[0]).toMatchObject({ amountCents: null, reRecordRefusal: "amount-unknown" });
  });
});

describe("the record-again note's key parts", () => {
  it("MUTATION: the key carries re-record:<resolution id>, so it can never be the voided note's", () => {
    expect(reRecordKeyParts("res-1")).toEqual(["re-record", "res-1"]);
    expect(buildXeroIdempotencyKey("payment", "pay-1", "refund-credit-note", ...reRecordKeyParts("res-1"), 0, "v3")).toBe(
      "payment:pay-1:refund-credit-note:re-record:res-1:0:v3",
    );
  });

  it("finds its own rows by the id their payload carries, and by the row it queued once known", () => {
    expect(reRecordNoteRowsWhere("pay-1", "res-1")).toMatchObject({
      localId: "pay-1",
      operationType: "CREATE",
      requestPayload: { path: ["reRecordId"], equals: "res-1" },
    });
    expect(reRecordNoteRowsWhere("pay-1", "res-1", "op-1")).toMatchObject({
      OR: [{ requestPayload: { path: ["reRecordId"], equals: "res-1" } }, { id: "op-1" }],
    });
  });
});

describe("the card self-heal never sees a bank transfer (#4162)", () => {
  it("MUTATION: the nightly self-heal reads the card report alone, never the bank-transfer list", () => {
    const cron = readFileSync(join(process.cwd(), "src/lib/cron-credit-reconciliation.ts"), "utf8");
    expect(cron).toContain("getRefundsMissingXeroCreditNotes");
    expect(cron).not.toMatch(/bank-refund-void|listBankRefundVoids|countBankRefundVoids/);
    const health = readFileSync(join(process.cwd(), "src/lib/xero-admin-health.ts"), "utf8");
    const reportBody = health.slice(health.indexOf("export async function getRefundsMissingXeroCreditNotes"));
    expect(reportBody.slice(0, reportBody.indexOf("orderBy"))).toMatch(/source: "STRIPE",/);
  });
});
