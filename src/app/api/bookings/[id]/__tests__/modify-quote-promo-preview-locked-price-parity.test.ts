/**
 * #4202: THE PROMO BOX AND THE QUOTE GIVE ONE DISCOUNT FOR ONE EDIT.
 *
 * The booking editor shows a code's discount twice: in the promo box
 * (`POST /api/promo-codes/validate`) and on the quote
 * (`POST /api/bookings/[id]/modify-quote`), which is what the save is held to
 * (INV-MOD-028). The quote prices the edit with each held night's sold price
 * (#1036, `INV-MOD-005`); the box used to price every night at today's rate,
 * so once the club's rates had moved since the booking was made the two
 * discounts differed.
 *
 * Each case below sends the SAME edit to both routes and compares the box's
 * answer with the quote's — one assertion over the pair, never an absolute
 * figure both sides could drift to together. Real pricing
 * (`priceBookingGuestsWithMembershipTypePolicy`), the real lock reader
 * (`editedGuestPricingLocks`) and the real promotion engine run on both sides;
 * only the database and the quote's unrelated collaborators (capacity, change
 * fee, Xero, settlement) are stubbed. A control case confirms the scenario
 * discriminates: today's rate on every night gives a different total.
 *
 * Frozen clock discipline: the booking is in late August 2026, after the
 * 2026-07-01 freeze; this file installs no clock of its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  authorizationRole: vi.fn(),
  prisma: {
    manualRefundTask: { findFirst: vi.fn(), findMany: vi.fn() },
    booking: { findUnique: vi.fn() },
    bookingGuest: { findMany: vi.fn() },
    bookingRequest: { findFirst: vi.fn() },
    promoCode: { findUnique: vi.fn(), findMany: vi.fn() },
    workPartyEvent: { findUnique: vi.fn() },
    season: { findMany: vi.fn() },
    groupDiscountSetting: { findUnique: vi.fn() },
    promoRedemptionAllocation: { aggregate: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    member: { findMany: vi.fn() },
    seasonalMembershipAssignment: { findMany: vi.fn() },
    membershipType: { findMany: vi.fn() },
    clubTimeSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/admin-permissions", () => ({ bookingManagementAuthorizationRole: h.authorizationRole }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { bookingQuery: {} },
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: vi.fn(async () => "lodge-1"),
  lodgeNullTolerantScope: () => ({}),
  // The lodge a request names, as the real resolver answers for an active one.
  resolveOptionalActiveLodgeId: vi.fn(async (_db: unknown, lodgeId?: string) => lodgeId ?? "lodge-1"),
}));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/lodge-capacity")),
  getLodgeCapacity: vi.fn(async () => 29),
}));
vi.mock("@/lib/capacity", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/capacity")),
  checkCapacityForGuestRanges: vi.fn(async () => ({ available: true, minAvailable: 5, nightDetails: [] })),
}));
vi.mock("@/lib/booking-member-night-conflicts", () => ({
  findBookingMemberNightConflicts: vi.fn(async () => []),
  getBookingMemberNightConflictResponse: (conflicts: unknown[]) => ({ conflicts }),
}));
// The lock reader, the beneficiary resolver and the rest stay REAL; only the
// helpers that read the database for questions this file does not ask are
// stubbed.
vi.mock("@/lib/booking-modify", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-modify")),
  isQuotePricedBooking: vi.fn(async () => false),
  isMemberWholeLodgeBooking: vi.fn(async () => false),
  calculateModificationSettlementOptions: vi.fn(async () => null),
}));
vi.mock("@/lib/booking-guests", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/booking-guests")),
  computeMemberGuestBoundary: vi.fn(async () => ({ scopeByMemberId: new Map(), beyondFamilyMemberIds: [] })),
  resolveLinkedBookingMembersWithBoundary: vi.fn(async () => ({
    members: new Map(),
    boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
  })),
  assertLinkedBookingMembersCanBeBooked: vi.fn(async () => undefined),
}));
vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-guest-add-policy")),
  loadMemberGuestAddPolicy: vi.fn(async () => ({
    wideningEnabled: false,
    approvalRequired: true,
    pendingHoldExpiryDays: 0,
  })),
}));
vi.mock("@/lib/booking-member-guest-subscriptions", () => ({ findUnpaidMemberGuestNames: vi.fn(async () => []) }));
vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: vi.fn(async () => []),
  daysUntilDate: vi.fn(() => 30),
}));
vi.mock("@/lib/change-fee", () => ({ calculateChangeFee: vi.fn(() => ({ feeCents: 0 })) }));
vi.mock("@/lib/module-settings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/module-settings")),
  loadEffectiveModuleFlags: vi.fn(async () => ({ xeroIntegration: false })),
}));
vi.mock("@/lib/xero-token-store", () => ({ isXeroConnected: vi.fn(async () => false) }));
vi.mock("@/lib/xero-organisation", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-organisation")),
  getXeroLockDates: vi.fn(async () => ({ periodLockDate: null, endOfYearLockDate: null })),
}));
vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: vi.fn(async () => ({ valid: true, violations: [] })),
  formatViolationsDetail: () => "minimum stay",
  formatViolationMessage: () => "minimum stay",
}));
vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: vi.fn(async () => 0),
  requireMemberCreditRecipient: (memberId: string | null) => {
    if (!memberId) throw new Error("no account to credit");
    return memberId;
  },
}));
vi.mock("@/lib/additional-ask-reduction", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/additional-ask-reduction")),
  readReductionAgainstUnpaidAsk: vi.fn(async () => ({ offsetCents: 0, askLeftCents: 0 })),
}));
vi.mock("@/lib/booking-modify-credit-give-back", () => ({
  previewPaidReductionCreditGiveBackCents: vi.fn(async () => 0),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST as modifyQuote } from "@/app/api/bookings/[id]/modify-quote/route";
import { POST as validatePromo } from "@/app/api/promo-codes/validate/route";

const D = (day: string) => new Date(`${day}T00:00:00.000Z`);
/** Today's rate for a night. */
const NOW_RATE = 5000;
/** What each night already on the booking was sold at, before the rates went up. */
const SOLD = 4000;
const HELD = ["2026-08-24", "2026-08-25", "2026-08-26"];

function promo(overrides: Record<string, unknown>) {
  return {
    id: "promo-1",
    code: "SAVE",
    description: null,
    type: "PERCENTAGE",
    active: true,
    archivedAt: null,
    internal: false,
    percentOff: null,
    valueCents: null,
    freeNightsPerIndividual: null,
    lifetimeFreeNightsCap: null,
    fixedNightlyPriceCents: null,
    fixedNightlyMode: null,
    maxGuestsPerBooking: null,
    maxNightlyValueCents: null,
    memberGuestsOnly: false,
    membersOnly: false,
    validFrom: null,
    validUntil: null,
    bookingStartFrom: null,
    bookingStartUntil: null,
    maxRedemptionsTotal: null,
    currentRedemptions: 0,
    maxUsesPerMember: null,
    maxUniqueMembersTotal: null,
    assignedMembersOnlyOwnNights: true,
    assignments: [],
    lodges: [],
    ...overrides,
  };
}

/** The stored guest: an adult member on 24-27 August, every night sold at the old rate. */
const storedGuest = {
  id: "g1",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m1",
  firstName: "Aroha",
  lastName: "Member",
  consentStatus: null,
  otherLodgeMember: false,
  stayStart: D("2026-08-24"),
  stayEnd: D("2026-08-27"),
  priceCents: 3 * SOLD,
  nights: HELD.map((night) => ({ stayDate: D(night), priceCents: SOLD, priceSource: "SOLD" })),
};

function storedBooking() {
  return {
    id: "b1",
    status: "DRAFT",
    memberId: "m1",
    lodgeId: "lodge-1",
    checkIn: D("2026-08-24"),
    checkOut: D("2026-08-27"),
    totalPriceCents: 3 * SOLD,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 3 * SOLD,
    payment: null,
    promoRedemption: null,
    promoRedemptions: [],
    guests: [storedGuest],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  h.authorizationRole.mockReturnValue("USER");
  h.prisma.manualRefundTask.findFirst.mockResolvedValue(null);
  h.prisma.manualRefundTask.findMany.mockResolvedValue([]);
  h.prisma.booking.findUnique.mockResolvedValue(storedBooking());
  h.prisma.bookingGuest.findMany.mockResolvedValue([storedGuest]);
  h.prisma.bookingRequest.findFirst.mockResolvedValue(null);
  h.prisma.season.findMany.mockResolvedValue([
    {
      id: "season-1",
      startDate: D("2026-06-01"),
      endDate: D("2026-10-31"),
      type: "WINTER",
      membershipTypeRates: [
        { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
        { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
      ],
    },
  ]);
  h.prisma.groupDiscountSetting.findUnique.mockResolvedValue(null);
  h.prisma.promoRedemptionAllocation.aggregate.mockResolvedValue({ _sum: { freeNightsUsed: 0 } });
  h.prisma.promoRedemptionAllocation.count.mockResolvedValue(0);
  h.prisma.promoRedemptionAllocation.findMany.mockResolvedValue([]);
  h.prisma.member.findMany.mockResolvedValue([]);
  h.prisma.seasonalMembershipAssignment.findMany.mockResolvedValue([]);
  h.prisma.membershipType.findMany.mockResolvedValue([
    { id: "type-nonmember", key: "NON_MEMBER" },
    { id: "type-full", key: "FULL" },
  ]);
  h.prisma.clubTimeSettings.findUnique.mockResolvedValue({
    timeZone: "Pacific/Auckland",
    updatedByMemberId: null,
    updatedAt: D("2026-01-01"),
  });
});

/**
 * An edit: the new check-out, the code, and whether a non-member friend joins
 * for the whole stay. `setup` arranges the case's world before either route
 * runs; `boxBody` and `boxGuest` are what the editor's box sends beyond the
 * common request.
 */
type Edit = {
  checkOut: string;
  promo: Record<string, unknown>;
  addFriend?: boolean;
  setup?: () => void;
  boxBody?: Record<string, unknown>;
  boxGuest?: Record<string, unknown>;
};

/** The quote's answer for the edit: its total and the promo line's discount. */
async function quote(edit: Edit) {
  h.prisma.promoCode.findUnique.mockResolvedValue(promo(edit.promo));
  const res = await modifyQuote(
    new NextRequest("http://localhost/api/bookings/b1/modify-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        checkIn: "2026-08-24",
        checkOut: edit.checkOut,
        promoCode: "SAVE",
        ...(edit.addFriend
          ? { addGuests: [{ firstName: "Kiri", lastName: "Friend", ageTier: "ADULT", isMember: false }] }
          : {}),
      }),
    }),
    { params: Promise.resolve({ id: "b1" }) },
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  expect(body.promoValidation?.valid, JSON.stringify(body.promoValidation)).toBe(true);
  return {
    totalPriceCents: body.newTotalPriceCents as number,
    discountCents: body.promoValidation.discountCents as number,
    promoAdjustmentCents: body.newPromoAdjustmentCents as number,
  };
}

/** The promo box's answer for the same edit, as the booking editor sends it. */
async function box(edit: Edit) {
  h.prisma.promoCode.findUnique.mockResolvedValue(promo(edit.promo));
  h.prisma.promoCode.findMany.mockResolvedValue([promo(edit.promo)]);
  const res = await validatePromo(
    new NextRequest("http://localhost/api/promo-codes/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "SAVE",
        checkIn: "2026-08-24",
        checkOut: edit.checkOut,
        forBookingEdit: true,
        bookingId: "b1",
        lodgeId: "lodge-1",
        ...edit.boxBody,
        guests: [
          {
            ageTier: "ADULT",
            isMember: true,
            memberId: "m1",
            bookingGuestId: "g1",
            stayStart: "2026-08-24",
            stayEnd: edit.checkOut,
            ...edit.boxGuest,
          },
          ...(edit.addFriend ? [{ ageTier: "ADULT", isMember: false }] : []),
        ],
      }),
    }),
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return {
    totalPriceCents: body.totalPriceCents as number,
    discountCents: body.discountCents as number,
    promoAdjustmentCents: body.promoAdjustmentCents as number,
  };
}

const EDITS: Array<[string, Edit]> = [
  ["a percentage code on a one-night extension", { checkOut: "2026-08-28", promo: { percentOff: 50 } }],
  ["a percentage code on an unmoved stay", { checkOut: "2026-08-27", promo: { percentOff: 30 } }],
  [
    "a free-nights code covering every night",
    { checkOut: "2026-08-28", promo: { type: "FREE_NIGHTS", freeNightsPerIndividual: 4 } },
  ],
  [
    "a free-nights code covering some nights",
    { checkOut: "2026-08-29", promo: { type: "FREE_NIGHTS", freeNightsPerIndividual: 2 } },
  ],
  [
    "a percentage code with a guest added",
    { checkOut: "2026-08-28", promo: { percentOff: 50 }, addFriend: true },
  ],
  [
    "a fixed nightly price",
    { checkOut: "2026-08-28", promo: { type: "FIXED_NIGHTLY_PRICE", fixedNightlyPriceCents: 1000 } },
  ],
];

describe("#4202 the promo box and the quote give one discount after the rates moved", () => {
  for (const [name, edit] of EDITS) {
    it(`agrees on the total and the discount: ${name}`, async () => {
      edit.setup?.();
      const quoted = await quote(edit);
      const boxed = await box(edit);
      expect(boxed).toEqual(quoted);
    });
  }

  it("the comparison has teeth: the quote does not price the held nights at today's rate", async () => {
    const quoted = await quote(EDITS[0]![1]);
    expect(quoted.totalPriceCents).toBe(3 * SOLD + NOW_RATE);
    expect(quoted.totalPriceCents).not.toBe(4 * NOW_RATE);
  });

  it("the added-guest case really prices the friend, at today's rate on every night", async () => {
    const [, edit] = EDITS.find(([, candidate]) => candidate.addFriend)!;
    expect((await quote(edit)).totalPriceCents).toBe(3 * SOLD + NOW_RATE + 4 * NOW_RATE);
  });
});

/** An officer editing the member's booking: the caller is not the booking's owner. */
function officerCalling() {
  h.auth.mockResolvedValue({ user: { id: "officer-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
  h.authorizationRole.mockReturnValue("ADMIN");
}

/**
 * #4202 (follow-on): beyond the prices, the box answers for the BOOKING the
 * quote prices — its own promotion slots left out of the usage caps, its stored
 * other-lodge flags, its owner and its lodge — not for whoever is asking or
 * whatever the request names.
 */
const BOOKING_EDITS: Array<[string, Edit]> = [
  [
    "a total-uses cap whose last slot is this booking's own",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, maxRedemptionsTotal: 1, currentRedemptions: 1 },
      setup: () =>
        h.prisma.promoRedemptionAllocation.count.mockImplementation(
          async ({ where }: { where?: { bookingId?: string } }) => (where?.bookingId === "b1" ? 1 : 0),
        ),
    },
  ],
  [
    "the same cap, through the box's several-code request",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, maxRedemptionsTotal: 1, currentRedemptions: 1 },
      boxBody: { code: undefined, codes: [{ code: "SAVE" }] },
      setup: () =>
        h.prisma.promoRedemptionAllocation.count.mockImplementation(
          async ({ where }: { where?: { bookingId?: string } }) => (where?.bookingId === "b1" ? 1 : 0),
        ),
    },
  ],
  [
    "a guest recognised as another club's member keeps that rate on the nights the edit buys",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50 },
      boxGuest: { isMember: false, memberId: undefined },
      setup: () => {
        const visitor = { ...storedGuest, isMember: false, memberId: null, otherLodgeMember: true };
        h.prisma.booking.findUnique.mockResolvedValue({ ...storedBooking(), guests: [visitor] });
        h.prisma.bookingGuest.findMany.mockResolvedValue([visitor]);
        h.prisma.season.findMany.mockResolvedValue([
          {
            id: "season-1",
            startDate: D("2026-06-01"),
            endDate: D("2026-10-31"),
            type: "WINTER",
            membershipTypeRates: [
              { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: NOW_RATE },
              { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 2 * NOW_RATE },
            ],
          },
        ]);
      },
    },
  ],
  [
    "an officer editing a member's booking, with a code assigned to that member",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, assignments: [{ memberId: "m1" }] },
      setup: officerCalling,
    },
  ],
  [
    "a request naming another lodge than the booking's, with a code for the booking's lodge",
    {
      checkOut: "2026-08-28",
      promo: { percentOff: 50, lodges: [{ lodgeId: "lodge-1" }] },
      boxBody: { lodgeId: "lodge-2" },
    },
  ],
];

describe("#4202 the box answers for the booking the quote prices", () => {
  for (const [name, edit] of BOOKING_EDITS) {
    it(`agrees on the total and the discount: ${name}`, async () => {
      edit.setup?.();
      const quoted = await quote(edit);
      const boxed = await box(edit);
      expect(boxed).toEqual(quoted);
    });
  }

  it("the other-lodge case has teeth: the bought night is at the member rate, not the non-member one", async () => {
    const [, edit] = BOOKING_EDITS[2]!;
    edit.setup?.();
    expect((await quote(edit)).totalPriceCents).toBe(3 * SOLD + NOW_RATE);
  });
});
