/**
 * AN IN-PROGRESS EDIT CARRIES ITS PROMOTION AND CAPS IT, NEVER RE-DECIDES IT
 * (#4317 review round 4, epic #4302).
 *
 * A stay already under way prices from the nights already agreed and keeps
 * every code the booking carries exactly as stored: never re-validated, so a
 * code that has since expired or been switched off is not dropped and the
 * member is not charged for a shorter stay. Where the change leaves less to pay
 * than the promotion takes off, the planner caps the promotion at the new total
 * (`buildInProgressGuestRangePlan`, `max(promo, -total)`) — the one figure the
 * quote shows and the save writes. This module brings the stored records into
 * line with that figure:
 *
 *  - each redemption's adjustment is scaled to its share of the cap, in
 *    proportion to its stored adjustment, and each member's allocation to its
 *    share of that (`apportionCents`, leftover cents on the earliest entry);
 *  - the redemption rows stay in place, guest targets and counters included —
 *    only `replacePromoRedemptionAllocations`, the writer every re-price uses,
 *    touches them, under the promo row locks (INV-MONEY-023);
 *  - no night-adjustment row is written here. After the night rewrite the save
 *    hands `scaleCappedCarriedRows` (below) to the writer,
 *    `restoreBookingNightAdjustments`, which scales the stored rows on the nights
 *    that remain to these figures — the one rule-derived amount INV-MONEY-029
 *    allows (owner decision 24 Oct 2026 on #4302).
 */
import type { Prisma } from "@prisma/client";

import { bookingDiscountCents } from "@/lib/booking-final-price";
import logger from "@/lib/logger";
import { apportionCents } from "@/lib/night-price-runs";
import { compareOrdinal } from "@/lib/ordinal-order";
import {
  deriveNightAdjustmentState,
  memberBenefitAllocations,
  type CappedCarryScaler,
  type CarriedNightAdjustments,
} from "@/lib/night-adjustment-write";
import {
  lockPromoCodeRowsForUpdate,
  replacePromoRedemptionAllocations,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";

/** A stored redemption, as the cap reads it. */
export type CarriedRedemption = {
  id: string;
  promoCodeId: string;
  bookingId: string;
  memberId: string | null;
  discountCents: number;
  priceAdjustmentCents: number;
  freeNightsUsed: number | null;
  eligibleGuestCount: number | null;
  allocations: ReadonlyArray<{
    memberId: string | null;
    discountCents: number;
    priceAdjustmentCents: number;
    freeNightsUsed: number;
  }>;
};

/** A redemption's figures once scaled to its share of the cap. */
export type ScaledRedemption = {
  redemption: CarriedRedemption;
  discountCents: number;
  priceAdjustmentCents: number;
  allocations: PromoBeneficiaryAllocation[];
};

/**
 * Scale stored redemptions, in their application order, so their adjustments
 * add up to `cappedPromoAdjustmentCents`. Pure. `null` when the records cannot
 * be scaled honestly: they did not add up to the booking's stored figure to
 * begin with, so there is no proportion to keep (the booking-level figure is
 * still capped; the records are left as they were).
 */
export function scaleCarriedRedemptions(
  redemptions: readonly CarriedRedemption[],
  storedPromoAdjustmentCents: number,
  cappedPromoAdjustmentCents: number,
): ScaledRedemption[] | null {
  const storedSum = redemptions.reduce((sum, redemption) => sum + redemption.priceAdjustmentCents, 0);
  if (redemptions.length === 0 || storedSum === 0 || storedSum !== storedPromoAdjustmentCents) return null;
  const figures = apportionCents(
    cappedPromoAdjustmentCents,
    redemptions.map((redemption) => redemption.priceAdjustmentCents),
  );
  return redemptions.map((redemption, index) => {
    const priceAdjustmentCents = figures[index]!;
    // The allocations a member's benefit decomposes, read the one way the
    // INV-MONEY-029 identity reads them.
    const members = memberBenefitAllocations(redemption.allocations);
    const memberSum = members.reduce((sum, allocation) => sum + allocation.priceAdjustmentCents, 0);
    const shares =
      memberSum === 0
        ? members.map((allocation) => allocation.priceAdjustmentCents)
        : apportionCents(priceAdjustmentCents, members.map((allocation) => allocation.priceAdjustmentCents));
    return {
      redemption,
      priceAdjustmentCents,
      discountCents: bookingDiscountCents({ promoAdjustmentCents: priceAdjustmentCents }),
      allocations: members.map((allocation, at) => ({
        memberId: allocation.memberId,
        priceAdjustmentCents: shares[at]!,
        discountCents: bookingDiscountCents({ promoAdjustmentCents: shares[at]! }),
        freeNightsUsed: allocation.freeNightsUsed,
      })),
    };
  });
}

/**
 * Write the scaled figures for a booking whose in-progress edit capped its
 * carried promotion. Runs inside the edit's transaction, which already holds
 * `lock(1)` and the per-lodge capacity key, so the order stays lodge -> promo
 * rows (INV-MONEY-023); every read precedes the first write.
 */
export async function capCarriedPromotionRecords(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    storedPromoAdjustmentCents: number;
    cappedPromoAdjustmentCents: number;
  },
): Promise<void> {
  const { bookingId } = params;
  const codes = await tx.promoRedemption.findMany({ where: { bookingId }, select: { promoCodeId: true } });
  if (codes.length === 0) return;
  await lockPromoCodeRowsForUpdate(tx, codes.map((code) => code.promoCodeId));
  const redemptions = await tx.promoRedemption.findMany({
    where: { bookingId },
    orderBy: [{ applicationOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      promoCodeId: true,
      bookingId: true,
      memberId: true,
      discountCents: true,
      priceAdjustmentCents: true,
      freeNightsUsed: true,
      eligibleGuestCount: true,
      allocations: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { memberId: true, discountCents: true, priceAdjustmentCents: true, freeNightsUsed: true },
      },
    },
  });
  const scaled = scaleCarriedRedemptions(
    redemptions,
    params.storedPromoAdjustmentCents,
    params.cappedPromoAdjustmentCents,
  );
  if (scaled === null) {
    logger.warn(
      { bookingId, storedPromoAdjustmentCents: params.storedPromoAdjustmentCents },
      "#4317: an in-progress edit capped the booking's promotion, but its redemptions did not add up to the stored figure, so they were left as they were; the build-up derives as not known",
    );
    return;
  }
  for (const entry of scaled) {
    await replacePromoRedemptionAllocations(
      tx,
      entry.redemption,
      entry.discountCents,
      entry.priceAdjustmentCents,
      entry.redemption.freeNightsUsed ?? undefined,
      entry.redemption.eligibleGuestCount ?? undefined,
      entry.allocations,
    );
  }
}

/** A night row before a guest-scope one; nights by date; then by guest. */
function earliestNightFirst(
  a: CarriedNightAdjustments["rows"][number],
  b: CarriedNightAdjustments["rows"][number],
): number {
  if (a.stayDate && b.stayDate) {
    const byNight = a.stayDate.getTime() - b.stayDate.getTime();
    if (byNight !== 0) return byNight;
  } else if (a.stayDate || b.stayDate) {
    return a.stayDate ? -1 : 1;
  }
  return compareOrdinal(a.bookingGuestId, b.bookingGuestId);
}

/**
 * THE ONE RULE-DERIVED AMOUNT (INV-MONEY-029's exception; owner decision
 * 24 Oct 2026 on #4302, #4317 review round 4). An in-progress edit capped its
 * carried promotion and `capCarriedPromotionRecords` scaled each redemption and
 * member allocation to the cap; here the stored rows left on the stay are
 * scaled to match, per redemption and beneficiary, in proportion to their
 * stored amounts, leftover cents on the earliest night (`apportionCents`). A
 * beneficiary whose rows already sum to its allocation keeps them byte for
 * byte. Returns the new amount of each row, in `rows` order, or `null` — write
 * none, the build-up is not known — where there is nothing to scale from: a
 * NOT KNOWN amount, a row naming no redemption the booking carries, an
 * allocation with no row left behind it, or a result that does not reconcile.
 * Pure: the writer, `restoreBookingNightAdjustments`, is handed it by the batch
 * save for a capped plan and writes what it returns.
 */
export const scaleCappedCarriedRows: CappedCarryScaler = (rows, redemptions) => {
  const known = new Set(redemptions.map((redemption) => redemption.id));
  const amounts: number[] = [];
  for (const row of rows) {
    if (row.amountCents === null || !known.has(row.promoRedemptionId)) return null;
    amounts.push(row.amountCents);
  }
  for (const redemption of redemptions) {
    const allocated = new Map(
      memberBenefitAllocations(redemption.allocations).map((allocation) => [
        allocation.memberId,
        allocation.priceAdjustmentCents,
      ]),
    );
    const mine = rows.flatMap((row, index) => (row.promoRedemptionId === redemption.id ? [index] : []));
    const members = new Set([...allocated.keys(), ...mine.map((index) => rows[index]!.beneficiaryMemberId)]);
    for (const memberId of members) {
      const group = mine
        .filter((index) => rows[index]!.beneficiaryMemberId === memberId)
        .sort((a, b) => earliestNightFirst(rows[a]!, rows[b]!));
      const target = allocated.get(memberId) ?? 0;
      const weights = group.map((index) => amounts[index]!);
      const stored = weights.reduce((sum, cents) => sum + cents, 0);
      if (stored === target) continue;
      if (stored === 0) return null;
      apportionCents(target, weights).forEach((cents, at) => {
        amounts[group[at]!] = cents;
      });
    }
    // The result must reconcile, read the one way every reader reads it.
    const state = deriveNightAdjustmentState({
      rows: mine.map((index) => ({
        beneficiaryMemberId: rows[index]!.beneficiaryMemberId,
        amountCents: amounts[index]!,
      })),
      redemption: {
        priceAdjustmentCents: redemption.priceAdjustmentCents,
        allocations: memberBenefitAllocations(redemption.allocations),
      },
    });
    if (state !== "KNOWN") return null;
  }
  return amounts;
};
