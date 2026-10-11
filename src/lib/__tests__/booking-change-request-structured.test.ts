import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part A: a locked-period change request must name a structured change.
 * A note on its own (the free-text "Admin Request" an in-progress stay used to
 * send) is refused; a request naming the guests it adds, with their nights
 * inside the stay, is accepted.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
  logAudit: vi.fn(),
  sendAdminBookingChangeRequestAlert: vi.fn(),
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
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...args: unknown[]) =>
    mocks.sendAdminBookingChangeRequestAlert(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/club-time/server", () => ({
  // The club's day for this suite: the stay below is under way.
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));

import { POST } from "@/app/api/bookings/[id]/change-requests/route";
import { CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE } from "@/lib/booking-change-request-guests";

function inProgressBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "PAID",
    checkIn: new Date("2026-06-30T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: new Date("2026-06-30T00:00:00.000Z"),
        stayEnd: new Date("2026-07-03T00:00:00.000Z"),
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

const grandchild = (firstName: string, nights: { stayStart?: string; stayEnd?: string } = {}) => ({
  firstName,
  lastName: "Example",
  ageTier: "CHILD",
  isMember: false,
  ...nights,
});

describe("POST /api/bookings/[id]/change-requests — a structured change is required (#4030)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    mocks.bookingFindUnique.mockResolvedValue(inProgressBooking());
    mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
    mocks.bookingChangeRequestCreate.mockImplementation(async (args: { data: unknown }) => ({
      id: "request-1",
      status: "REQUESTED",
      ...(args.data as object),
    }));
    mocks.sendAdminBookingChangeRequestAlert.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("refuses the free-text request the old card sent: an effective date and a note", async () => {
    const response = await post({
      requestedEffectiveDate: "2026-06-30",
      reason: "Can we add these three grandchildren to our booking",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("STRUCTURED_CHANGE_REQUIRED");
    expect(body.error).toBe(CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
    expect(mocks.sendAdminBookingChangeRequestAlert).not.toHaveBeenCalled();
  });

  it("refuses a note with nothing else", async () => {
    const response = await post({ reason: "Please add my grandchildren" });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("STRUCTURED_CHANGE_REQUIRED");
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("accepts a request naming the guests it adds, from a locked night, with the note kept", async () => {
    const response = await post({
      addGuests: [
        grandchild("Ari", { stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
        grandchild("Bo", { stayStart: "2026-07-01", stayEnd: "2026-07-03" }),
      ],
      reason: "They arrived with us.",
    });
    expect(response.status).toBe(201);
    const { data } = mocks.bookingChangeRequestCreate.mock.calls[0][0] as {
      data: { reason: string; requestedChanges: { requested: Record<string, unknown> } };
    };
    expect(data.reason).toBe("They arrived with us.");
    expect(data.requestedChanges.requested).toMatchObject({
      addGuests: [
        expect.objectContaining({ firstName: "Ari", stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
        expect.objectContaining({ firstName: "Bo", stayStart: "2026-07-01", stayEnd: "2026-07-03" }),
      ],
      summary: "add Ari Example, Bo Example",
    });
  });

  it("reads a guest with no nights as staying the whole stay, which reaches back to a locked night", async () => {
    const response = await post({ addGuests: [grandchild("Ari")] });
    expect(response.status).toBe(201);
  });

  it("refuses a guest whose nights fall outside the stay", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-06-29", stayEnd: "2026-07-03" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/must fall within the stay \(2026-06-30 to 2026-07-03\)/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses a guest whose date out is not after their date in", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-07-01", stayEnd: "2026-07-01" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/date out must be after their date in/);
  });

  it("sends a guest added only from tomorrow to the guest editor (not a locked-period change)", async () => {
    const response = await post({
      addGuests: [grandchild("Ari", { stayStart: "2026-07-02", stayEnd: "2026-07-03" })],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/past-night changes that require admin review/);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });
});
