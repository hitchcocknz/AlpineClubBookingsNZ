import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4030 Part A: the estimate an in-progress change-request card shows for the
 * guests it adds. The pricing engine is real; only the reads around it are
 * stubbed.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  loadActiveSeasonRates: vi.fn(),
  groupDiscountFindUnique: vi.fn(),
  resolveGuestRateMembershipTypes: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    groupDiscountSetting: {
      findUnique: (...args: unknown[]) => mocks.groupDiscountFindUnique(...args),
    },
  },
}));
vi.mock("@/lib/lodges", () => ({ getDefaultLodgeId: async () => "lodge-1" }));
vi.mock("@/lib/booking-modify-plan", () => ({
  loadActiveSeasonRates: (...args: unknown[]) => mocks.loadActiveSeasonRates(...args),
}));
vi.mock("@/lib/member-subscription-eligibility", () => ({
  resolveSubscriptionLockoutMode: async () => "HARD_BLOCK",
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveGroupDiscountRateType: async (_db: unknown, config: unknown) => config,
  resolveGuestRateMembershipTypes: (...args: unknown[]) =>
    mocks.resolveGuestRateMembershipTypes(...args),
}));

import { estimateChangeRequestAddedGuests } from "@/lib/booking-change-request-estimate";
import { POST } from "@/app/api/bookings/[id]/change-requests/quote/route";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const SEASON = {
  seasonId: "season-1",
  startDate: day("2026-06-01"),
  endDate: day("2026-09-30"),
  type: "SUMMER" as const,
  rates: [
    { membershipTypeId: "NON_MEMBER", ageTier: "CHILD" as const, pricePerNightCents: 2000 },
    { membershipTypeId: "NON_MEMBER", ageTier: "ADULT" as const, pricePerNightCents: 4000 },
    { membershipTypeId: "FULL", ageTier: "CHILD" as const, pricePerNightCents: 1000 },
  ],
};

function booking(guestCount = 1) {
  return {
    memberId: "member-1",
    deletedAt: null,
    checkIn: day("2026-06-30"),
    checkOut: day("2026-07-03"),
    lodgeId: "lodge-1",
    guests: Array.from({ length: guestCount }, () => ({
      stayStart: day("2026-06-30"),
      stayEnd: day("2026-07-03"),
      ageTier: "ADULT" as const,
      isMember: true,
      rateMembershipTypeId: "FULL",
      nights: [{ stayDate: day("2026-06-30") }, { stayDate: day("2026-07-01") }, { stayDate: day("2026-07-02") }],
    })),
  };
}

const child = (firstName: string, extra: Record<string, unknown> = {}) => ({
  firstName,
  lastName: "Example",
  ageTier: "CHILD" as const,
  isMember: false,
  ...extra,
});

describe("estimateChangeRequestAddedGuests (#4030)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadActiveSeasonRates.mockResolvedValue([SEASON]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.resolveGuestRateMembershipTypes.mockImplementation(
      async (_db: unknown, params: { guests: Array<Record<string, unknown>> }) =>
        params.guests.map((guest) => ({
          ...guest,
          rateMembershipTypeId: "NON_MEMBER",
          rateSource: "NON_MEMBER_DEFAULT",
        })),
    );
  });

  it("prices each non-member guest on their own nights at the season rate", async () => {
    const estimate = await estimateChangeRequestAddedGuests(booking(), [
      child("Ari", { stayStart: "2026-06-30", stayEnd: "2026-07-03" }),
      child("Bo", { stayStart: "2026-07-01", stayEnd: "2026-07-02" }),
    ]);
    expect(estimate).toEqual({
      outcome: "priced",
      guests: [
        { priceCents: 6000, nights: 3 },
        { priceCents: 2000, nights: 1 },
      ],
      totalCents: 8000,
      excludesMemberGuests: false,
    });
  });

  it("never resolves a member guest's rate, and leaves them out of the total", async () => {
    const estimate = await estimateChangeRequestAddedGuests(booking(), [
      child("Ari"),
      { ...child("Cam"), isMember: true, memberId: "member-9" },
    ]);
    expect(estimate).toMatchObject({
      outcome: "priced",
      guests: [{ priceCents: 6000, nights: 3 }, { priceCents: null, nights: 3 }],
      totalCents: 6000,
      excludesMemberGuests: true,
    });
    // The resolver was handed only the non-member, and with no member id.
    const resolved = mocks.resolveGuestRateMembershipTypes.mock.calls[0][1] as {
      guests: Array<{ memberId: unknown; isMember: boolean }>;
    };
    expect(resolved.guests).toEqual([expect.objectContaining({ isMember: false, memberId: null })]);
  });

  it("counts the guests already on the booking toward the group discount, without pricing them", async () => {
    mocks.groupDiscountFindUnique.mockResolvedValue({
      enabled: true,
      applyToEdits: true,
      minGroupSize: 3,
      summerOnly: false,
      rateMembershipTypeId: "FULL",
    });
    // Two existing + one added = 3: the added child is priced at the FULL rate.
    const estimate = await estimateChangeRequestAddedGuests(booking(2), [child("Ari")]);
    expect(estimate).toMatchObject({ outcome: "priced", totalCents: 3000 });
    // One existing + one added = 2: below the size, the non-member rate.
    const smaller = await estimateChangeRequestAddedGuests(booking(1), [child("Ari")]);
    expect(smaller).toMatchObject({ outcome: "priced", totalCents: 6000 });
  });

  it("says the nights can't be priced when no active season covers them", async () => {
    mocks.loadActiveSeasonRates.mockResolvedValue([]);
    const estimate = await estimateChangeRequestAddedGuests(booking(), [child("Ari")]);
    expect(estimate).toEqual({ outcome: "unpriced", message: expect.stringMatching(/can't be priced/) });
  });
});

describe("POST /api/bookings/[id]/change-requests/quote (#4030)", () => {
  function post(body: unknown) {
    return POST(
      new NextRequest("http://localhost/api/bookings/booking-1/change-requests/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [] } });
    mocks.bookingFindUnique.mockResolvedValue(booking());
    mocks.loadActiveSeasonRates.mockResolvedValue([SEASON]);
    mocks.groupDiscountFindUnique.mockResolvedValue(null);
    mocks.resolveGuestRateMembershipTypes.mockImplementation(
      async (_db: unknown, params: { guests: Array<Record<string, unknown>> }) =>
        params.guests.map((guest) => ({ ...guest, rateMembershipTypeId: "NON_MEMBER" })),
    );
  });

  it("answers the owner with the estimate", async () => {
    const response = await post({ addGuests: [child("Ari", { stayStart: "2026-07-01", stayEnd: "2026-07-03" })] });
    expect(response.status).toBe(200);
    expect((await response.json()).estimate).toMatchObject({ outcome: "priced", totalCents: 4000 });
  });

  it("refuses somebody else's booking", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "member-2", role: "MEMBER", accessRoles: [] } });
    const response = await post({ addGuests: [child("Ari")] });
    expect(response.status).toBe(403);
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("answers a deleted booking exactly as a missing one (INV-ADDPAY-031)", async () => {
    mocks.bookingFindUnique.mockResolvedValue({ ...booking(), deletedAt: new Date("2026-06-01T00:00:00.000Z") });
    const response = await post({ addGuests: [child("Ari")] });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Booking not found" });
  });

  it("refuses nights outside the stay", async () => {
    const response = await post({ addGuests: [child("Ari", { stayStart: "2026-06-29" })] });
    expect(response.status).toBe(400);
    expect(mocks.loadActiveSeasonRates).not.toHaveBeenCalled();
  });

  it("refuses an empty list", async () => {
    const response = await post({ addGuests: [] });
    expect(response.status).toBe(400);
  });
});
