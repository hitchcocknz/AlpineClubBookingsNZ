import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part B: the admin list says which pending finished-stay requests take
 * an officer's entry (those that name no change), and how far the officer's
 * member finder reaches.
 */

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  gate: vi.fn(),
  user: { id: "officer-1" } as Record<string, unknown>,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () => ({ ok: true, session: { user: mocks.user } }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingChangeRequest: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      count: async () => 3,
    },
  },
}));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));
vi.mock("@/lib/member-guest-find-service", () => ({
  loadMemberGuestFindGate: (...args: unknown[]) => mocks.gate(...args),
}));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: (user: { membershipView?: boolean }) => user.membershipView === true,
}));

import { GET } from "@/app/api/admin/booking-change-requests/route";

const original = { checkIn: "2026-06-10", checkOut: "2026-06-14", guests: [{ id: "g1" }] };
const freeText = {
  original,
  requested: { addGuests: [], removeGuests: [], guestStayRanges: [], requestedEffectiveDate: "2026-06-10" },
};
const structured = {
  original,
  requested: {
    addGuests: [{ firstName: "A", lastName: "B", ageTier: "ADULT", isMember: false }],
    removeGuests: [],
    guestStayRanges: [],
  },
};
const finished = {
  checkIn: new Date("2026-06-10T00:00:00.000Z"),
  checkOut: new Date("2026-06-14T00:00:00.000Z"),
  status: "COMPLETED",
};
const running = { ...finished, checkOut: new Date("2026-07-02T00:00:00.000Z"), status: "PAID" };

function row(id: string, requestedChanges: unknown, booking: unknown, status = "REQUESTED") {
  return { id, status, requestedChanges, booking };
}

async function list() {
  const response = await GET(new NextRequest("http://localhost/api/admin/booking-change-requests?status=ALL"));
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: "officer-1" };
  mocks.gate.mockResolvedValue({ ok: true, settings: {} });
});

describe("GET /api/admin/booking-change-requests — acceptsOfficerGuests (#4030)", () => {
  it("is true only for a pending free-text request on a finished stay", async () => {
    mocks.findMany.mockResolvedValue([
      row("free-finished", freeText, finished),
      row("structured-finished", structured, finished),
      row("free-running", freeText, running),
      row("free-approved", freeText, finished, "APPROVED"),
    ]);
    const body = await list();
    expect(
      Object.fromEntries(body.data.map((r: { id: string; acceptsOfficerGuests: boolean }) => [r.id, r.acceptsOfficerGuests])),
    ).toEqual({
      "free-finished": true,
      "structured-finished": false,
      "free-running": false,
      "free-approved": false,
    });
  });

  it("offers the finder by email to any officer, and by name only with the membership directory", async () => {
    mocks.findMany.mockResolvedValue([row("free-finished", freeText, finished)]);
    expect((await list()).memberGuestFind).toEqual({ openSearchEnabled: false });
    mocks.user = { id: "officer-1", membershipView: true };
    expect((await list()).memberGuestFind).toEqual({ openSearchEnabled: true });
  });

  it("offers no finder when the club's member-guest module is off, or no card takes an entry", async () => {
    mocks.findMany.mockResolvedValue([row("free-finished", freeText, finished)]);
    mocks.gate.mockResolvedValue({ ok: false });
    expect((await list()).memberGuestFind).toBeNull();
    mocks.gate.mockClear();
    mocks.findMany.mockResolvedValue([row("structured-finished", structured, finished)]);
    expect((await list()).memberGuestFind).toBeNull();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("reads only the member ids of the booking's guests, for the finder", async () => {
    mocks.findMany.mockResolvedValue([]);
    await list();
    const [args] = mocks.findMany.mock.calls[0] as [
      { include: { booking: { select: { guests: unknown } } } },
    ];
    expect(args.include.booking.select.guests).toEqual({
      where: { memberId: { not: null } },
      select: { memberId: true },
    });
  });

  it("returns the guests' member ids only on rows that take an officer's entry (review S7)", async () => {
    const withGuests = (booking: object) => ({ ...booking, guests: [{ memberId: "member-7" }] });
    mocks.findMany.mockResolvedValue([
      row("free-finished", freeText, withGuests(finished)),
      row("structured-finished", structured, withGuests(finished)),
    ]);
    const body = await list();
    const byId = Object.fromEntries(
      body.data.map((r: { id: string; booking: Record<string, unknown> }) => [r.id, r.booking]),
    );
    expect(byId["free-finished"].guests).toEqual([{ memberId: "member-7" }]);
    expect(byId["structured-finished"]).not.toHaveProperty("guests");
  });
});

describe("GET /api/admin/booking-change-requests — requestedGuestNights (#4088)", () => {
  it("answers each guest's requested nights, as runs, for the card", async () => {
    mocks.findMany.mockResolvedValue([
      row(
        "grid",
        {
          original: { ...original, guests: [{ id: "g1", firstName: "Jo", lastName: "Bloggs", stayStart: "2026-06-10", stayEnd: "2026-06-14" }] },
          requested: { guestStayRanges: [{ guestId: "g1", nights: ["2026-06-10", "2026-06-11", "2026-06-13"] }] },
        },
        finished,
      ),
      row("free-finished", freeText, finished),
    ]);
    const body = await list();
    expect(body.data.map((r: { requestedGuestNights: unknown }) => r.requestedGuestNights)).toEqual([
      [
        {
          name: "Jo Bloggs",
          runs: [
            { firstNight: "2026-06-10", lastNight: "2026-06-11" },
            { firstNight: "2026-06-13", lastNight: "2026-06-13" },
          ],
          nightCount: 3,
          added: false,
          unchanged: false,
          fillsGaps: false,
        },
      ],
      [],
    ]);
  });
});
