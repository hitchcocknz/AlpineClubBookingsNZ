import "server-only";

import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import type { ClubFormat } from "@/lib/club-format";
import { prisma } from "@/lib/prisma";
import {
  activeWindow,
  ageLabel,
  ageSort,
  isPublicContentEnabled,
  loadAgeTierLabels,
  money,
  type PublicFeeGroup,
  type PublicMoney,
} from "@/lib/public-page-content-tokens";

export type PublicFirstYearCostOptions = { typeKey?: string };

/**
 * #4295: what it costs to join, as one figure per membership type and age tier:
 * the current joining fee plus the current annual fee, both from the dated
 * schedules the invoicing reads. A tier with no row of its own falls back to the
 * type's flat (NULL-tier) row, as the invoicing resolvers do; a flat
 * `PER_FAMILY` annual fee is added once. A tier whose annual fee is NO_INVOICE
 * adds nothing, and one with no annual fee at all is left out, because a joining
 * fee alone would read as the whole first-year cost. A fee with a proration rule
 * shows "from", since a mid-season joiner's first invoice is smaller. Needs BOTH
 * the Joining fees and Annual membership fees opt-ins; off means nothing renders.
 */
export async function loadPublicFirstYearCosts(
  format: ClubFormat,
  options: PublicFirstYearCostOptions = {},
): Promise<PublicFeeGroup[]> {
  const [joiningOn, annualOn] = await Promise.all([
    isPublicContentEnabled("entranceFees"),
    isPublicContentEnabled("annualFees"),
  ]);
  if (!joiningOn || !annualOn) return [];
  const today = await clubTodayDateOnlyInstant();
  const [types, tiers] = await Promise.all([
    prisma.membershipType.findMany({
      where: { isActive: true, publiclyListed: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        ageGroupsApply: true,
        joiningFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true },
        },
        annualFees: {
          where: activeWindow(today),
          orderBy: [{ effectiveFrom: "desc" }],
          select: { ageTier: true, amountCents: true, billingBasis: true, prorationRule: true },
        },
      },
    }),
    loadAgeTierLabels(),
  ]);
  const listed = options.typeKey
    ? types.filter((type) => type.key.toLowerCase() === options.typeKey!.toLowerCase())
    : types;

  const FLAT = "FLAT";
  const rows: Array<{ sort: number; label: string; fee: PublicMoney }> = [];
  let typeOrder = 0;
  for (const type of listed) {
    typeOrder += 1;
    // Rows are effectiveFrom desc, so the first seen per tier is current.
    const joining = new Map<string, number>();
    for (const row of type.joiningFees) {
      const key = row.ageTier ?? FLAT;
      if (!joining.has(key)) joining.set(key, row.amountCents);
    }
    const annual = new Map<string, { cents: number; prorated: boolean }>();
    for (const row of type.annualFees) {
      const key = row.ageTier ?? FLAT;
      if (annual.has(key)) continue;
      annual.set(key, {
        cents: row.billingBasis === "NO_INVOICE" ? 0 : row.amountCents,
        prorated: row.billingBasis !== "NO_INVOICE" && row.prorationRule !== "NONE",
      });
    }
    for (const key of new Set([...joining.keys(), ...annual.keys()])) {
      const yearly = annual.get(key) ?? annual.get(FLAT);
      if (!yearly) continue;
      const totalCents = (joining.get(key) ?? joining.get(FLAT) ?? 0) + yearly.cents;
      if (totalCents <= 0) continue;
      const tier = type.ageGroupsApply && key !== FLAT ? key : null;
      const fee = money(totalCents, format);
      rows.push({
        sort: typeOrder * 1_000_000_000 + Math.min(ageSort(tiers, tier), 999_999_999),
        label: tier === null ? type.name : `${type.name} — ${ageLabel(tiers, tier)}`,
        fee: yearly.prorated ? { ...fee, label: `from ${fee.label}` } : fee,
      });
    }
  }
  if (rows.length === 0) return [];
  return [{
    heading: "Joining fee plus first year's subscription",
    rows: rows.sort((a, b) => a.sort - b.sort).map(({ label, fee }) => ({ label, fee })),
  }];
}
