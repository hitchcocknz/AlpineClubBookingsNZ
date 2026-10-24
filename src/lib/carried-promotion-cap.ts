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
 *  - no night-adjustment amount is computed here. The save carries the stored
 *    rows on the nights that remain, byte for byte, only where they still
 *    reconcile to the scaled figures (`restoreBookingNightAdjustments`,
 *    `survivorsOnly`); otherwise the build-up derives as not known
 *    (INV-MONEY-029: an amount is the engine's own figure, never a rule's).
 */
import type { Prisma } from "@prisma/client";

import { bookingDiscountCents } from "@/lib/booking-final-price";
import logger from "@/lib/logger";
import { memberBenefitAllocations } from "@/lib/night-adjustment-write";
import {
  lockPromoCodeRowsForUpdate,
  replacePromoRedemptionAllocations,
  type PromoBeneficiaryAllocation,
} from "@/lib/promo";

/**
 * Split `totalCents` across entries in proportion to their `weights`, in whole
 * cents that add up to it exactly. Each share is truncated toward zero; the
 * cents truncation leaves go one each to the earliest entries with a weight,
 * the way an even split puts its leftover cents on the earliest nights
 * (`evenlySplitCents`). The weights must not sum to zero.
 */
export function apportionCents(totalCents: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum === 0) {
    throw new Error("apportionCents: the weights sum to zero, so there is no proportion to keep");
  }
  const shares = weights.map((weight) => Math.trunc((totalCents * weight) / weightSum));
  let leftover = totalCents - shares.reduce((sum, share) => sum + share, 0);
  const step = Math.sign(leftover);
  const weighted = weights.flatMap((weight, index) => (weight === 0 ? [] : [index]));
  for (let turn = 0; leftover !== 0; turn += 1) {
    const at = weighted[turn % weighted.length]!;
    shares[at] = shares[at]! + step;
    leftover -= step;
  }
  return shares;
}

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
