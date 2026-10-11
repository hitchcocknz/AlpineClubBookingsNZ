import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireCalendarDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4030 Part B, the routes' half: `PATCH /api/admin/booking-change-requests/[id]`
 * and its quote accept the officer's entry only on an approval that applies the
 * request, hand it to the executor unchanged, and the approval's audit row names
 * the officer and lists the guests entered on the member's behalf. The executor
 * is a double (`booking-change-request-officer-entry.test.ts` proves the engine).
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requestFindUnique: vi.fn(),
  requestUpdateMany: vi.fn(),
  execute: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findUnique: (...args: unknown[]) => mocks.requestFindUnique(...args),
      updateMany: (...args: unknown[]) => mocks.requestUpdateMany(...args),
    },
    bookingModification: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTime: async () => ({ today: () => requireCalendarDate("2026-07-01") }),
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => CLUB_FORMAT_TEST }));
vi.mock("@/lib/booking-change-request-execution", () => ({
  approveAndExecuteLockedPeriodChangeRequest: (...args: unknown[]) => mocks.execute(...args),
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  prepareBatchModificationForCallerTransaction: async () => ({ marker: "pre" }),
}));

import { PATCH } from "@/app/api/admin/booking-change-requests/[id]/route";
import { POST as QUOTE } from "@/app/api/admin/booking-change-requests/[id]/quote/route";
import { OFFICER_GUESTS_NEED_EXECUTION_MESSAGE } from "@/lib/booking-change-request-admin-decision";

const GUESTS = [
  { firstName: "Ari", lastName: "Example", ageTier: "CHILD", isMember: false, stayStart: "2026-06-10", stayEnd: "2026-06-14" },
  { firstName: "Cam", lastName: "Example", ageTier: "YOUTH", isMember: true, memberId: "member-7", stayStart: "2026-06-11", stayEnd: "2026-06-14" },
];

function call(handler: typeof PATCH | typeof QUOTE, url: string, method: string, body: unknown) {
  return handler(
    new NextRequest(url, {
      method,
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "cr-1" }) },
  );
}
const patch = (body: unknown) =>
  call(PATCH, "http://localhost/api/admin/booking-change-requests/cr-1", "PATCH", body);
const quote = (body: unknown) =>
  call(QUOTE, "http://localhost/api/admin/booking-change-requests/cr-1/quote", "POST", body);

function preRead(booking: Record<string, unknown>) {
  return {
    id: "cr-1",
    kind: "LOCKED_PERIOD",
    status: "REQUESTED",
    version: 2,
    booking: { id: "booking-1", memberId: "member-1", ...booking },
  };
}
const FINISHED = { checkOut: new Date("2026-06-14T00:00:00.000Z"), status: "COMPLETED" };
const RUNNING = { checkOut: new Date("2026-07-02T00:00:00.000Z"), status: "PAID" };

const EXECUTED = {
  outcome: "executed",
  requestId: "cr-1",
  bookingId: "booking-1",
  requestedByMemberId: "member-1",
  modificationId: "mod-9",
  addedGuestCount: 2,
  removedGuestCount: 0,
  priceDiffCents: 10_000,
  changeFeeCents: 0,
  additionalAmountCents: 10_000,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  capacityOverridden: false,
  settlementMethod: "card",
  officerEnteredGuests: GUESTS,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  mocks.execute.mockResolvedValue(EXECUTED);
});

describe("PATCH — the officer's entry (#4030 Part B)", () => {
  it("hands the entry to the executor and names the officer and the guests on the audit row", async () => {
    mocks.requestFindUnique
      .mockResolvedValueOnce(preRead(FINISHED))
      .mockResolvedValueOnce({ id: "cr-1", status: "APPROVED", linkedModificationId: "mod-9" });

    const response = await patch({
      status: "APPROVED",
      execute: true,
      expectedVersion: 2,
      adminNotes: "Added your grandchildren.",
      officerGuests: GUESTS,
    });

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: "officer-1", officerEnteredGuests: GUESTS, dryRun: false }),
    );
    expect((await response.json()).execution).toMatchObject({
      executed: true,
      officerEnteredGuestCount: 2,
    });
    const [audit] = mocks.logAudit.mock.calls[0] as [Record<string, unknown>];
    expect(audit).toMatchObject({
      action: "booking-change-request.approve",
      memberId: "officer-1",
      summary: expect.stringMatching(/entered by the booking officer on the member's behalf/),
      metadata: expect.objectContaining({
        executed: true,
        officerEnteredGuests: {
          onMemberBehalf: true,
          enteredByMemberId: "officer-1",
          guests: [
            expect.objectContaining({ firstName: "Ari", memberId: null, stayStart: "2026-06-10" }),
            expect.objectContaining({ firstName: "Cam", memberId: "member-7", stayEnd: "2026-06-14" }),
          ],
        },
      }),
    });
  });

  it("records no entry on an ordinary executed approval", async () => {
    mocks.execute.mockResolvedValue({ ...EXECUTED, officerEnteredGuests: null });
    mocks.requestFindUnique
      .mockResolvedValueOnce(preRead(FINISHED))
      .mockResolvedValueOnce({ id: "cr-1" });
    await patch({ status: "APPROVED", execute: true, adminNotes: "ok" });
    expect(mocks.execute.mock.calls[0][0]).not.toHaveProperty("officerEnteredGuests");
    const [audit] = mocks.logAudit.mock.calls[0] as [{ metadata: Record<string, unknown> }];
    expect(audit.metadata.officerEnteredGuests).toBeNull();
  });

  it("refuses an entry on a rejection, writing nothing", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(FINISHED));
    const response = await patch({ status: "REJECTED", adminNotes: "no", officerGuests: GUESTS });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(OFFICER_GUESTS_NEED_EXECUTION_MESSAGE);
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses an entry on an acknowledgement of a stay still running", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(preRead(RUNNING));
    const response = await patch({
      status: "APPROVED",
      execute: false,
      adminNotes: "ok",
      officerGuests: GUESTS,
    });
    expect(response.status).toBe(400);
    expect(mocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an entry whose guests do not state their nights", async () => {
    const response = await patch({
      status: "APPROVED",
      execute: true,
      adminNotes: "ok",
      officerGuests: [{ firstName: "Ari", lastName: "Example", ageTier: "CHILD", isMember: false }],
    });
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("refuses an empty entry", async () => {
    const response = await patch({ status: "APPROVED", execute: true, adminNotes: "ok", officerGuests: [] });
    expect(response.status).toBe(400);
  });
});

describe("POST quote — the officer's entry (#4030 Part B)", () => {
  it("prices the entry with the same executor, as a dry run", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce({ ...preRead(FINISHED) });
    mocks.execute.mockResolvedValue({
      outcome: "quoted",
      priceDiffCents: 10_000,
      changeFeeCents: 0,
      additionalAmountCents: 10_000,
      refundAmountCents: 0,
      accountCreditAmountCents: 0,
      capacityOverridden: false,
      settlementMethod: "card",
    });
    const response = await quote({ officerGuests: GUESTS });
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, officerEnteredGuests: GUESTS }),
    );
    expect((await response.json()).quote).toMatchObject({ additionalAmountCents: 10_000, changeFeeCents: 0 });
  });
});
