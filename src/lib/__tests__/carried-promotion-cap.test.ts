import { describe, expect, it } from "vitest";

import { scaleCarriedRedemptions, type CarriedRedemption } from "@/lib/carried-promotion-cap";
import { apportionCents } from "@/lib/night-price-runs";

/**
 * #4317 review round 4 (epic #4302): AN IN-PROGRESS EDIT CARRIES ITS PROMOTION
 * AND CAPS IT. The planner caps the booking's figure at the new total; these
 * pin how the stored redemptions and allocations are scaled to that figure -
 * in proportion, in whole cents, leftover cents on the earliest entry - for
 * every kind of code, without re-deciding any of them.
 */

function redemption(
  id: string,
  priceAdjustmentCents: number,
  allocations: Array<[string | null, number, number?]>,
  extra: Partial<CarriedRedemption> = {},
): CarriedRedemption {
  return {
    id,
    promoCodeId: `code-${id}`,
    bookingId: "booking-1",
    memberId: "owner",
    discountCents: Math.max(0, -priceAdjustmentCents),
    priceAdjustmentCents,
    freeNightsUsed: null,
    eligibleGuestCount: 1,
    allocations: allocations.map(([memberId, cents, freeNights]) => ({
      memberId,
      priceAdjustmentCents: cents,
      discountCents: Math.max(0, -cents),
      freeNightsUsed: freeNights ?? 0,
    })),
    ...extra,
  };
}

const figures = (scaled: ReturnType<typeof scaleCarriedRedemptions>) =>
  scaled?.map((entry) => ({
    id: entry.redemption.id,
    priceAdjustmentCents: entry.priceAdjustmentCents,
    discountCents: entry.discountCents,
    allocations: entry.allocations.map((allocation) => [
      allocation.memberId,
      allocation.priceAdjustmentCents,
      allocation.discountCents,
      allocation.freeNightsUsed,
    ]),
  }));

describe("apportionCents", () => {
  it("splits in proportion and adds up exactly, leftover cents on the earliest entries", () => {
    expect(apportionCents(-1_001, [-3_333, -6_667])).toEqual([-334, -667]);
    expect(apportionCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportionCents(-10_000, [-35_000])).toEqual([-10_000]);
  });

  it("gives an entry with no weight nothing, not even a leftover cent", () => {
    expect(apportionCents(101, [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it("refuses weights that sum to zero: there is no proportion to keep", () => {
    expect(() => apportionCents(100, [0, 0])).toThrow(/sum to zero/);
  });
});

describe("scaleCarriedRedemptions", () => {
  it("a fixed $350 code on a stay cut to $100 is scaled to -$100, its holder's allocation with it", () => {
    expect(figures(scaleCarriedRedemptions([redemption("r1", -35_000, [["owner", -35_000]])], -35_000, -10_000))).toEqual([
      { id: "r1", priceAdjustmentCents: -10_000, discountCents: 10_000, allocations: [["owner", -10_000, 10_000, 0]] },
    ]);
  });

  it("a 100% code is scaled to whatever is left", () => {
    expect(figures(scaleCarriedRedemptions([redemption("r1", -40_000, [["owner", -40_000]])], -40_000, -10_000))).toEqual([
      { id: "r1", priceAdjustmentCents: -10_000, discountCents: 10_000, allocations: [["owner", -10_000, 10_000, 0]] },
    ]);
  });

  it("stacked codes share the cap in proportion to what each took, in their application order", () => {
    const scaled = scaleCarriedRedemptions(
      [redemption("first", -3_333, [["owner", -3_333]]), redemption("second", -6_667, [["owner", -6_667]])],
      -10_000,
      -1_001,
    );
    expect(figures(scaled)).toEqual([
      { id: "first", priceAdjustmentCents: -334, discountCents: 334, allocations: [["owner", -334, 334, 0]] },
      { id: "second", priceAdjustmentCents: -667, discountCents: 667, allocations: [["owner", -667, 667, 0]] },
    ]);
  });

  it("a free-nights code keeps the nights it recorded as used; only its money is scaled", () => {
    const scaled = scaleCarriedRedemptions(
      [redemption("r1", -20_000, [["owner", -12_000, 2], ["partner", -8_000, 1]], { freeNightsUsed: 3 })],
      -20_000,
      -5_001,
    );
    expect(figures(scaled)).toEqual([
      {
        id: "r1",
        priceAdjustmentCents: -5_001,
        discountCents: 5_001,
        // -5001 x 0.6 = -3000.6 and -5001 x 0.4 = -2000.4: the leftover cent
        // goes to the earliest allocation.
        allocations: [
          ["owner", -3_001, 3_001, 2],
          ["partner", -2_000, 2_000, 1],
        ],
      },
    ]);
    expect(scaled?.[0]?.redemption.freeNightsUsed).toBe(3);
  });

  it("leaves a booker slot that names no member to the writer, as every re-price does", () => {
    const scaled = scaleCarriedRedemptions([redemption("r1", -1_000, [[null, -1_000]])], -1_000, -400);
    expect(figures(scaled)).toEqual([{ id: "r1", priceAdjustmentCents: -400, discountCents: 400, allocations: [] }]);
  });

  it("scales nothing where the records do not add up to the stored figure, or there are none", () => {
    expect(scaleCarriedRedemptions([redemption("r1", -3_000, [["owner", -3_000]])], -5_000, -1_000)).toBeNull();
    expect(scaleCarriedRedemptions([], -5_000, -1_000)).toBeNull();
  });
});
