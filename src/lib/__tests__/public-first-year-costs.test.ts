import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  membershipTypes: vi.fn(),
  ageTiers: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  membershipType: { findMany: mocks.membershipTypes },
  ageTierSetting: { findMany: mocks.ageTiers },
} }));

import { loadPublicFirstYearCosts } from "@/lib/public-first-year-costs";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Object.fromEntries(Object.keys(select).map((key) => [key, true])),
  );
});

describe("loadPublicFirstYearCosts (#4295)", () => {
  const tiers = [
    { tier: "YOUTH", label: "Youth", sortOrder: 1 },
    { tier: "ADULT", label: "Adult", sortOrder: 2 },
  ];
  const annual = (ageTier: string | null, amountCents: number, extra: Record<string, unknown> = {}) => ({
    ageTier, amountCents, billingBasis: "PER_MEMBER", prorationRule: "NONE", ...extra,
  });
  const row = (label: string, amountCents: number, feeLabel: string) => ({ label, fee: { amountCents, label: feeLabel } });
  const heading = "Joining fee plus first year's subscription";

  it("adds the joining fee to the annual fee per tier and per-family fee once", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full Member", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 32000 }, { ageTier: "YOUTH", amountCents: 12000 }],
        annualFees: [annual("ADULT", 7000), annual("YOUTH", 3500)] },
      { key: "FAMILY", name: "Family", ageGroupsApply: true,
        joiningFees: [{ ageTier: null, amountCents: 36000 }],
        annualFees: [annual(null, 14000, { billingBasis: "PER_FAMILY" })] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [
        row("Full Member — Youth", 15500, "$155.00"),
        row("Full Member — Adult", 39000, "$390.00"),
        row("Family", 50000, "$500.00"),
      ] },
    ]);
  });

  it("uses the fee that is current today, so a dated change flips the totals with no edit", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true,
        joiningFees: [{ ageTier: "ADULT", amountCents: 32000 }],
        // effectiveFrom desc: the first row per tier is the current one.
        annualFees: [annual("ADULT", 8500), annual("ADULT", 7000)] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Full — Adult", 40500, "$405.00")] },
    ]);
    const where = mocks.membershipTypes.mock.calls[0][0].select;
    expect(where.joiningFees.where).toEqual(where.annualFees.where);
    expect(where.annualFees.orderBy).toEqual([{ effectiveFrom: "desc" }]);
  });

  it("falls back to the flat row for a tier with none of its own", async () => {
    mocks.ageTiers.mockResolvedValue(tiers);
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true,
        joiningFees: [{ ageTier: null, amountCents: 10000 }],
        annualFees: [annual("ADULT", 7000)] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Full — Adult", 17000, "$170.00")] },
    ]);
  });

  it("counts a no-invoice annual fee as nothing and drops a type that totals zero", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "LIFE", name: "Life", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 5000 }],
        annualFees: [annual(null, 0, { billingBasis: "NO_INVOICE" })] },
      { key: "GUEST", name: "Guest", ageGroupsApply: false, joiningFees: [],
        annualFees: [annual(null, 0, { billingBasis: "NO_INVOICE" })] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [row("Life", 5000, "$50.00")] },
    ]);
  });

  it("leaves out a tier with no annual fee set, rather than showing the joining fee as the total", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FAMILY", name: "Family", ageGroupsApply: true, joiningFees: [{ ageTier: null, amountCents: 36000 }], annualFees: [] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([]);
  });

  it("shows 'from' when the annual fee is prorated", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "ORG", name: "Org", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 1000 }],
        annualFees: [annual(null, 9000, { prorationRule: "REMAINING_MONTHS_INCLUSIVE" })] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([
      { heading, rows: [{ label: "Org", fee: { amountCents: 10000, label: "from $100.00" } }] },
    ]);
  });

  it("limits to one listed type, and an unlisted type gives the empty state", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 1000 }], annualFees: [annual(null, 2000)] },
      { key: "FAMILY", name: "Family", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 3000 }], annualFees: [annual(null, 4000)] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST, { typeKey: "family" })).resolves.toEqual([
      { heading, rows: [row("Family", 7000, "$70.00")] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST, { typeKey: "NOT_LISTED" })).resolves.toEqual([]);
  });

  it.each([["entranceFees"], ["annualFees"]])("renders nothing while the %s opt-in is off", async (off) => {
    mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, key !== off])),
    );
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: false, joiningFees: [{ ageTier: null, amountCents: 1000 }], annualFees: [annual(null, 2000)] },
    ]);
    await expect(loadPublicFirstYearCosts(CLUB_FORMAT_TEST)).resolves.toEqual([]);
    expect(mocks.membershipTypes).not.toHaveBeenCalled();
  });
});
