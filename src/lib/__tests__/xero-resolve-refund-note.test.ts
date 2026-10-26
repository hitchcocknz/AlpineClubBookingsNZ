import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4421 (owner decision 26 Oct 2026, `INV-INT-025`): "Resolve by hand" on a
 * payment refund credit-note create that names no note of its own asks for
 * the Xero note's number, checks it with the #4162 hand-made answer's own
 * check, and records it with the resolve - refused when any other create row
 * or link here records it. Every other row resolves as before.
 *
 * A fake database stands in for PostgreSQL (the real races are in
 * `resolve-records-refund-note.realdb.test.ts`); the Xero check is stubbed at
 * the shared `verifyHandMadeRefundNote`, whose own checks are pinned by
 * `bank-refund-void-answer.test.ts`.
 */

type Row = Record<string, unknown> & { id: string };
type Link = { id: string; xeroObjectType: string; xeroObjectId: string };

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  links: [] as Array<{ id: string; xeroObjectType: string; xeroObjectId: string }>,
  calls: [] as string[],
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  createAuditLog: vi.fn(),
  verifyHandMadeRefundNote: vi.fn(),
  readPaymentHandMadeNoteExpectation: vi.fn(),
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const c = condition as { in?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(value);
      if ("not" in c) return value !== c.not;
    }
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    return value === condition;
  });
}

const fakeDb = vi.hoisted(() => {
  const operations = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = state.rows.get(where.id);
      return row ? { ...row } : null;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      // The retry-overlap and live-copy reads: no retry, no queued copy.
      if (where.operationType === "REQUEUE" || "status" in where) return null;
      state.calls.push("read rows recording the note");
      const { id, ...rest } = where as { id?: { not: string } } & Record<string, unknown>;
      const found = [...state.rows.values()].find((row) => row.id !== id?.not && matchesRef.current(row, rest));
      return found ? { id: found.id } : null;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      state.calls.push("updateMany");
      const row = state.rows.get(where.id as string);
      if (!row || !matchesRef.current(row, where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const matchesRef: { current: (row: Record<string, unknown>, where: Record<string, unknown>) => boolean } = { current: () => false };
  const links = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      state.calls.push("read links recording the note");
      const found = state.links.find((link) => matchesRef.current(link, where));
      return found ? { id: found.id } : null;
    },
  };
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      state.calls.push(strings.join("?").trim());
      return 1;
    },
    xeroSyncOperation: operations,
    xeroObjectLink: links,
  };
  return {
    matchesRef,
    prisma: {
      ...tx,
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => {
        state.calls.push("BEGIN");
        const snapshot = new Map([...state.rows].map(([key, row]) => [key, { ...row }]));
        try {
          const result = await run(tx);
          state.calls.push("COMMIT");
          return result;
        } catch (error) {
          state.rows.clear();
          for (const [key, row] of snapshot) state.rows.set(key, row);
          state.calls.push("ROLLBACK");
          throw error;
        }
      },
    },
  };
});
fakeDb.matchesRef.current = matches;

vi.mock("@/lib/prisma", () => ({ prisma: fakeDb.prisma }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog, logAudit: vi.fn() }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));
vi.mock("@/lib/bank-refund-void-answer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bank-refund-void-answer")),
  verifyHandMadeRefundNote: mocks.verifyHandMadeRefundNote,
  readPaymentHandMadeNoteExpectation: mocks.readPaymentHandMadeNoteExpectation,
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { POST as resolveOperation } from "@/app/api/admin/xero/operations/[id]/resolve/route";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { refundNoteResolveShape, resolveAsksCreditNoteNumber, type RefundNoteResolveRow } from "@/lib/xero-resolve-refund-note";

/** A FAILED $200 refund note on pay_1, queued and never raised: no note of its own. */
function refundNoteRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "op_note",
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "pay_1",
    status: "FAILED",
    queueType: "REFUND_CREDIT_NOTE",
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 20_000, watermarkCents: 20_000, refundMethod: "internet-banking" },
    responsePayload: null,
    correlationKey: "payment:pay_1:refund-credit-note:20000:v2",
    idempotencyKey: "payment:pay_1:refund-credit-note:20000:v2",
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    manuallyResolvedAt: null,
    manuallyResolvedReason: null,
    manuallyResolvedById: null,
    replayable: true,
    ...overrides,
  };
}

const VERIFIED = { creditNoteId: "cn-hand", creditNoteNumber: "CN-0789", amountCents: 20_000, status: "AUTHORISED", total: 200, updatedDateUTC: null };

function resolve(body: Record<string, unknown>, id = "op_note") {
  return resolveOperation(
    new NextRequest(`http://localhost/api/admin/xero/operations/${id}/resolve`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  );
}

const withNumber = { reason: "Made the credit note by hand in Xero", creditNoteNumber: "CN-0789" };

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.clear();
  state.links.length = 0;
  state.calls.length = 0;
  mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.readPaymentHandMadeNoteExpectation.mockResolvedValue({ xeroInvoiceId: "inv_1", ownerXeroContactId: "contact_1" });
  mocks.verifyHandMadeRefundNote.mockResolvedValue(VERIFIED);
  mocks.createAuditLog.mockResolvedValue(undefined);
});

describe("which rows 'Resolve by hand' asks a note number of (#4421)", () => {
  const shape = (overrides: Partial<Row>) => refundNoteResolveShape(refundNoteRow(overrides) as unknown as RefundNoteResolveRow);

  it("asks it of a payment refund note's create that names no note, sized on the row's own refund amount", () => {
    expect(shape({})).toEqual({ kind: "asks-number", paymentId: "pay_1", amountCents: 20_000 });
    // The executed shape, and a legacy row with no queue type, read the same way the coverage reader reads them.
    expect(shape({ queueType: null, requestPayload: { allocation: { invoiceId: "inv_1", amount: 150 }, creditNotes: [] } })).toEqual({ kind: "asks-number", paymentId: "pay_1", amountCents: 15_000 });
    // A note that names the invoice it credits is checked against that invoice's contact.
    expect(shape({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, creditsInvoiceId: "inv_receipt" } })).toMatchObject({ creditsInvoiceId: "inv_receipt" });
    expect(resolveAsksCreditNoteNumber(refundNoteRow() as unknown as RefundNoteResolveRow)).toBe(true);
  });

  it("leaves a row that already names its note, a refund request's note, a covered-by row, an account-credit note and every other row as before", () => {
    expect(shape({ status: "PARTIAL", xeroObjectId: "cn-own" })).toEqual({ kind: "records-note" });
    // #4391's: a refund request's note, by its payload or by its key.
    expect(shape({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundRequestId: "rr_1" } })).toEqual({ kind: "other" });
    expect(shape({ correlationKey: "payment:pay_1:refund-request-credit-note:rr_1", idempotencyKey: null, requestPayload: null })).toEqual({ kind: "other" });
    expect(shape({ responsePayload: { coveredByExistingNote: true } })).toEqual({ kind: "other" });
    expect(shape({ queueType: "ACCOUNT_CREDIT_NOTE", requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: 20_000 } })).toEqual({ kind: "other" });
    expect(shape({ queueType: null, requestPayload: { creditNotes: [{ lineItems: [{ unitAmount: 200 }] }] } })).toEqual({ kind: "other" });
    expect(shape({ entityType: "INVOICE" })).toEqual({ kind: "other" });
    expect(shape({ localModel: "Member" })).toEqual({ kind: "other" });
    expect(shape({ direction: "INBOUND" })).toEqual({ kind: "other" });
  });

  it("calls a refund note whose amount cannot be read unreadable, so it is refused rather than guessed", () => {
    expect(shape({ requestPayload: null })).toEqual({ kind: "unreadable", paymentId: "pay_1" });
  });
});

describe("Resolve by hand records the officer's note on a refund credit-note create (#4421)", () => {
  it("checks the note against the row's own amount and the payment's contact, then records it with the resolve under lock(1)", async () => {
    state.rows.set("op_note", refundNoteRow());

    const response = await resolve(withNumber);

    expect(response.status).toBe(200);
    expect((await response.json()).message).toContain("recording credit note CN-0789");
    expect(mocks.readPaymentHandMadeNoteExpectation).toHaveBeenCalledWith("pay_1", undefined);
    expect(mocks.verifyHandMadeRefundNote).toHaveBeenCalledWith(
      expect.objectContaining({ creditNoteNumber: "CN-0789", expectedAmountCents: 20_000, xeroInvoiceId: "inv_1", ownerXeroContactId: "contact_1" }),
    );
    expect(state.rows.get("op_note")).toMatchObject({
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: "cn-hand",
      xeroObjectNumber: "CN-0789",
      manuallyResolvedReason: "Made the credit note by hand in Xero",
      manuallyResolvedById: "admin-1",
      manuallyResolvedAt: expect.any(Date),
    });
    // The Xero check ran before the transaction; lock(1) is its first statement.
    expect(state.calls.slice(0, 5)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(1)",
      "read rows recording the note",
      "read links recording the note",
      "updateMany",
    ]);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "xero.operation.manually_resolved", metadata: expect.objectContaining({ creditNoteId: "cn-hand", creditNoteNumber: "CN-0789", amountCents: 20_000 }) }),
    );
  });

  it("MUTATION: refuses without a note number, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    for (const body of [{ reason: "Made it in Xero" }, { reason: "Made it in Xero", creditNoteNumber: "   " }]) {
      const response = await resolve(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Type the number of the credit note you made in Xero/);
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: null });
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("passes the Xero check's refusal through in plain English, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    mocks.verifyHandMadeRefundNote.mockRejectedValue(new ManualBookingPaymentError("Credit note CN-0789 is for $150.00 in Xero, not $200.00, so it does not record this refund.", 409));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/not \$200\.00/);
    expect(state.calls).not.toContain("BEGIN");
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: null });
  });

  it("MUTATION: refuses a note another credit-note create row records - any payment, any status - and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.rows.set("op_other", refundNoteRow({ id: "op_other", localId: "pay_2", status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand", xeroObjectNumber: "CN-0789" }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/CN-0789 is already recorded against another refund or booking here/);
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: null });
    expect(state.calls).not.toContain("updateMany");
    expect(state.calls).toContain("ROLLBACK");
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("MUTATION: refuses a note any link records - the #4162 answer's, or any other - and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow());
    state.links.push({ id: "link_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand" });

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already recorded against another refund/);
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: null });
    expect(state.calls).not.toContain("updateMany");
  });

  it("MUTATION: claims the row status-guarded - a row that names a note or was resolved since the read loses, and nothing is written", async () => {
    state.rows.set("op_note", refundNoteRow());
    // The row as the unlocked read saw it; under the lock it already names a note (a retry raised it in the meantime).
    const unlockedRead = refundNoteRow();
    const findUnique = vi.spyOn(fakeDb.prisma.xeroSyncOperation, "findUnique");
    findUnique.mockResolvedValueOnce(unlockedRead as never).mockImplementation(async () => ({ ...refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own" }) }) as never);
    state.rows.set("op_note", refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own" }));

    const response = await resolve(withNumber);
    findUnique.mockRestore();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/changed while it was being resolved/);
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null, xeroObjectId: "cn-own" });
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("MUTATION: the claim's own guard holds even past the re-read: it writes only an unresolved FAILED/PARTIAL row naming no note", async () => {
    state.rows.set("op_note", refundNoteRow());
    const updateMany = vi.spyOn(fakeDb.prisma.xeroSyncOperation, "updateMany");

    await resolve(withNumber);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "op_note", status: { in: ["FAILED", "PARTIAL"] }, manuallyResolvedAt: null, xeroObjectId: null },
      data: expect.objectContaining({ xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand", xeroObjectNumber: "CN-0789" }),
    });
    updateMany.mockRestore();
  });

  it("refuses a refund note whose amount cannot be read, and writes nothing", async () => {
    state.rows.set("op_note", refundNoteRow({ requestPayload: null }));

    const response = await resolve(withNumber);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/cannot read this refund credit note's amount/);
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
    expect(state.rows.get("op_note")).toMatchObject({ manuallyResolvedAt: null });
  });

  it("resolves a refund request's note, a row naming its note and any other row exactly as before: no number, no lock, no note written", async () => {
    for (const row of [
      refundNoteRow({ requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 30_000, refundRequestId: "rr_1" } }),
      refundNoteRow({ status: "PARTIAL", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-own", xeroObjectNumber: "CN-0001" }),
      refundNoteRow({ entityType: "CONTACT", operationType: "UPDATE", localModel: "Member", queueType: null, requestPayload: null }),
    ]) {
      state.rows.clear();
      state.calls.length = 0;
      state.rows.set("op_note", row);
      const before = { xeroObjectType: row.xeroObjectType, xeroObjectId: row.xeroObjectId, xeroObjectNumber: row.xeroObjectNumber };

      const response = await resolve({ reason: "Fixed by hand in Xero", creditNoteNumber: "CN-0789" });

      expect(response.status).toBe(200);
      expect(state.calls).not.toContain("BEGIN");
      expect(state.rows.get("op_note")).toMatchObject({ ...before, manuallyResolvedAt: expect.any(Date) });
    }
    expect(mocks.verifyHandMadeRefundNote).not.toHaveBeenCalled();
  });
});
