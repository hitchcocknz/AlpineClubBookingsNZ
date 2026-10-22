import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * #4295: the Join page's first-year total must be the sum of what the invoicing
 * would charge. Both the page loader and `getEffectiveJoiningFee` /
 * `getEffectiveMembershipAnnualFee` read the same dated fee rows here, through
 * one in-memory store that answers `where` and `orderBy` as PostgreSQL would
 * (`matchesWhere`), so a precedence or date-window rule changed in one place and
 * not the other fails this test rather than showing a visitor a wrong price.
 */
const TODAY = new Date("2027-03-31T00:00:00.000Z");
vi.mock("@/lib/club-time/server", () => ({ clubTodayDateOnlyInstant: vi.fn(async () => TODAY) }));

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
type FeeRow = { membershipTypeId: string; ageTier: string | null; amountCents: number; effectiveFrom: Date; effectiveTo: Date | null; billingBasis?: string; prorationRule?: string };

const joiningRows: FeeRow[] = [
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 32000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "full", ageTier: "YOUTH", amountCents: 12000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  { membershipTypeId: "family", ageTier: null, amountCents: 36000, effectiveFrom: day("2020-01-01"), effectiveTo: null },
  // Expired and not-yet-effective rows must not be picked up by either side.
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 99900, effectiveFrom: day("2019-01-01"), effectiveTo: day("2019-12-31") },
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 41000, effectiveFrom: day("2027-04-01"), effectiveTo: null },
];
const annualRows: FeeRow[] = [
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 7000, effectiveFrom: day("2020-01-01"), effectiveTo: day("2027-03-31"), billingBasis: "PER_MEMBER", prorationRule: "NONE" },
  { membershipTypeId: "full", ageTier: "ADULT", amountCents: 8500, effectiveFrom: day("2027-04-01"), effectiveTo: null, billingBasis: "PER_MEMBER", prorationRule: "NONE" },
  { membershipTypeId: "full", ageTier: "YOUTH", amountCents: 3500, effectiveFrom: day("2020-01-01"), effectiveTo: day("2027-03-31"), billingBasis: "PER_MEMBER", prorationRule: "NONE" },
  { membershipTypeId: "family", ageTier: null, amountCents: 14000, effectiveFrom: day("2020-01-01"), effectiveTo: null, billingBasis: "PER_FAMILY", prorationRule: "NONE" },
];

const { matchesWhere } = await import("./support/prisma-where");

type Query = { where?: Record<string, unknown>; orderBy?: unknown };
function read(rows: FeeRow[], query: Query): FeeRow[] {
  return rows
    .filter((row) => matchesWhere(row, query.where))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
}
const store = {
  joiningFee: { findFirst: async (query: Query) => read(joiningRows, query)[0] ?? null },
  membershipAnnualFee: { findFirst: async (query: Query) => read(annualRows, query)[0] ?? null },
};

const mocks = vi.hoisted(() => ({ settings: vi.fn(), membershipTypes: vi.fn(), ageTiers: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  membershipType: { findMany: mocks.membershipTypes },
  ageTierSetting: { findMany: mocks.ageTiers },
} }));

import { getEffectiveJoiningFee, getEffectiveMembershipAnnualFee } from "@/lib/authoritative-fees";
import { loadPublicFirstYearCosts } from "@/lib/public-first-year-costs";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type Select = { joiningFees: Query; annualFees: Query };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
    Object.fromEntries(Object.keys(select).map((key) => [key, true])),
  );
  mocks.ageTiers.mockResolvedValue([
    { tier: "YOUTH", label: "Youth", sortOrder: 1 },
    { tier: "ADULT", label: "Adult", sortOrder: 2 },
  ]);
  mocks.membershipTypes.mockImplementation(async ({ select }: { select: Select }) =>
    [
      { id: "full", key: "FULL", name: "Full", ageGroupsApply: true },
      { id: "family", key: "FAMILY", name: "Family", ageGroupsApply: true },
    ].map((type) => ({
      ...type,
      joiningFees: read(joiningRows.filter((row) => row.membershipTypeId === type.id), select.joiningFees),
      annualFees: read(annualRows.filter((row) => row.membershipTypeId === type.id), select.annualFees),
    })),
  );
});

describe("first-year costs agree with the invoicing resolvers (#4295)", () => {
  const cases = [
    { label: "Full — Youth", membershipTypeId: "full", ageTier: "YOUTH" as const },
    { label: "Full — Adult", membershipTypeId: "full", ageTier: "ADULT" as const },
    { label: "Family", membershipTypeId: "family", ageTier: null },
  ];

  it.each(cases)("$label equals the resolved joining fee plus the resolved annual fee", async ({ label, membershipTypeId, ageTier }) => {
    const joining = await getEffectiveJoiningFee({ membershipTypeId, ageTier }, TODAY, store as never);
    const annual = await getEffectiveMembershipAnnualFee({ membershipTypeId, ageTier }, TODAY, store as never);
    const expected = (joining.amountCents ?? 0) + (annual?.amountCents ?? 0);

    const groups = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST);
    const row = groups.flatMap((group) => group.rows).find((candidate) => candidate.label === label);
    expect(row?.fee.amountCents).toBe(expected);
  });

  it("on the last day of the old schedule, uses the old annual fee for the adult row", async () => {
    // 32000 joining + 7000 annual: the 41000 / 8500 rows start tomorrow.
    const groups = await loadPublicFirstYearCosts(CLUB_FORMAT_TEST);
    expect(groups[0].rows.find((row) => row.label === "Full — Adult")?.fee.amountCents).toBe(39000);
  });
});
