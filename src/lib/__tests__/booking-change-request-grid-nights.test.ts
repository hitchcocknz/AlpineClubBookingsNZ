import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4088: a change request sent from the booking editor's per-night grid keeps
 * each guest's night set (#713). The route's schema used to strip
 * `guestStayRanges[].nights` and `addGuests[].nights`, so the stored request
 * lost the member's nights and approval reset every guest to the booking's
 * dates. Here: the route keeps them, the stored request reads them back onto
 * the canonical batch input, and a range-only request is unchanged.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    member: { findMany: async () => [] },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimiters: { bookingChangeRequest: { id: "booking-change-request" } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  // The club's day: the stay below (30 June to 3 July) is under way.
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));

import { POST } from "@/app/api/bookings/[id]/change-requests/route";
import { CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE } from "@/lib/booking-change-request-guests";
import {
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesNoChange,
} from "@/lib/booking-change-request-stored";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const STAY_NIGHTS = ["2026-06-30", "2026-07-01", "2026-07-02"];

function booking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: day("2026-06-30"),
    checkOut: day("2026-07-03"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: day("2026-06-30"),
        stayEnd: day("2026-07-03"),
        nights: STAY_NIGHTS.map((night) => ({ stayDate: day(night) })),
      },
    ],
    member: { id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.com" },
    organisation: null,
    payment: null,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/change-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

/** What the route stored on its one create, as the column holds it. */
function storedChanges(): unknown {
  expect(mocks.bookingChangeRequestCreate).toHaveBeenCalledTimes(1);
  const { data } = mocks.bookingChangeRequestCreate.mock.calls[0][0] as {
    data: { requestedChanges: unknown };
  };
  // Through JSON, as the database round-trips it.
  return JSON.parse(JSON.stringify(data.requestedChanges));
}

const grandchild = {
  firstName: "Ari",
  lastName: "Example",
  ageTier: "CHILD",
  isMember: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mocks.bookingFindUnique.mockResolvedValue(booking());
  mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
  mocks.bookingChangeRequestCreate.mockImplementation(async (args: { data: unknown }) => ({
    id: "request-1",
    status: "REQUESTED",
    ...(args.data as object),
  }));
});

describe("POST /api/bookings/[id]/change-requests keeps a grid request's night sets (#4088)", () => {
  it("stores an existing guest's night set, and the nights each guest held", async () => {
    // The grid drops the guest's 1 July night: a gap, so the dates do not move.
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as {
      original: { guests: Array<Record<string, unknown>> };
      requested: { guestStayRanges: unknown };
    };
    expect(stored.requested.guestStayRanges).toEqual([
      { guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] },
    ]);
    expect(stored.original.guests[0]).toMatchObject({
      id: "guest-1",
      stayStart: "2026-06-30",
      stayEnd: "2026-07-03",
      nights: STAY_NIGHTS,
    });
  });

  it("stores an added guest's night set, and reads its first night as where it starts", async () => {
    const response = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-02"] }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as { requested: { addGuests: unknown } };
    expect(stored.requested.addGuests).toEqual([
      expect.objectContaining({ firstName: "Ari", nights: ["2026-06-30", "2026-07-02"] }),
    ]);

    // From tomorrow only, it is an ordinary edit, not a locked-period change:
    // the first night decides, as Date In does.
    mocks.bookingChangeRequestCreate.mockClear();
    const tomorrow = await post({ addGuests: [{ ...grandchild, nights: ["2026-07-02"] }] });
    expect(tomorrow.status).toBe(400);
    expect((await tomorrow.json()).error).toMatch(/past-night changes that require admin review/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("stores a grid request that moves the dates with the nights that moved them", async () => {
    const response = await post({
      checkIn: "2026-06-29",
      guestStayRanges: [
        { guestId: "guest-1", nights: ["2026-06-29", "2026-06-30", "2026-07-02"] },
      ],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedChanges() as { requested: Record<string, unknown> };
    expect(stored.requested).toMatchObject({
      checkIn: "2026-06-29",
      guestStayRanges: [
        { guestId: "guest-1", nights: ["2026-06-29", "2026-06-30", "2026-07-02"] },
      ],
    });
  });

  it("does not count a night set repeating the guest's own nights as a change", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: [...STAY_NIGHTS].reverse() }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
  });

  it("reads night sets by the editor's own rules", async () => {
    const malformed = await post({
      guestStayRanges: [{ guestId: "guest-1", nights: ["30/06/2026"] }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("Validation failed");

    // An added guest's nights must fall inside the stay, as their dates must.
    const outside = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-03"] }],
    });
    expect(outside.status).toBe(400);
    expect((await outside.json()).error).toMatch(/must fall within the stay \(2026-06-30 to 2026-07-03\)/);

    // A date move the night set does not reach is refused, as for ranges.
    const unreached = await post({
      checkIn: "2026-06-28",
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-29", "2026-06-30"] }],
    });
    expect(unreached.status).toBe(400);
    expect((await unreached.json()).error).toBe(CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });
});

describe("the stored grid request, read back for approval (#4088)", () => {
  const live = { checkIn: day("2026-06-30"), checkOut: day("2026-07-03") };

  it("round-trips each guest's night set onto the canonical batch input", async () => {
    const response = await post({
      addGuests: [{ ...grandchild, nights: ["2026-06-30", "2026-07-02"] }],
      guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }],
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
    const stored = storedLockedPeriodRequestSchema.parse(storedChanges());
    const input = lockedPeriodRequestToBatchInput(stored, live);
    expect(input?.guestStayRanges).toEqual([
      { guestId: "guest-1", stayStart: null, stayEnd: null, nights: ["2026-06-30", "2026-07-02"] },
    ]);
    expect(input?.addGuests).toEqual([
      expect.objectContaining({ firstName: "Ari", nights: ["2026-06-30", "2026-07-02"] }),
    ]);
  });

  it("reads a night set repeating the guest's stored nights as no change", () => {
    const requestedChanges = {
      original: {
        checkIn: "2026-06-30",
        checkOut: "2026-07-03",
        guests: [{ id: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03", nights: STAY_NIGHTS }],
      },
      requested: {
        guestStayRanges: [{ guestId: "guest-1", nights: STAY_NIGHTS }],
      },
    };
    expect(storedRequestNamesNoChange(requestedChanges, live)).toBe(true);
    // Before #4088 a row stored no nights: a night set is then compared with
    // the guest's stored range, every night of it.
    const older = {
      ...requestedChanges,
      original: {
        ...requestedChanges.original,
        guests: [{ id: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-03" }],
      },
    };
    expect(storedRequestNamesNoChange(older, live)).toBe(true);
    const gap = {
      ...requestedChanges,
      requested: { guestStayRanges: [{ guestId: "guest-1", nights: ["2026-06-30", "2026-07-02"] }] },
    };
    expect(storedRequestNamesNoChange(gap, live)).toBe(false);
  });

  it("maps a range-only request exactly as before: bounds, and no nights", async () => {
    const response = await post({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
      requestedEffectiveDate: "2026-06-30",
    });
    expect(response.status).toBe(201);
    const stored = storedLockedPeriodRequestSchema.parse(storedChanges());
    expect(lockedPeriodRequestToBatchInput(stored, live)).toEqual({
      guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-06-30", stayEnd: "2026-07-01" }],
    });
  });
});
