import { describe, expect, it } from "vitest";

import {
  carriedCapRowScaler,
  scaleCappedCarriedRows,
  scaleCarriedRedemptions,
  type CarriedRedemption,
} from "@/lib/carried-promotion-cap";
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

  it("leaves the records as they were where an allocation names no member: the writer would delete that row (round 6)", () => {
    // A school's booker slot. The shared writer does not rewrite it, so scaling
    // would drop the row and lower the code's currentRedemptions.
    expect(scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -600], [null, -400]])], -1_000, -400)).toBeNull();
  });

  it("leaves the records as they were where the cap would scale an allocation to nothing (round 6)", () => {
    // -$0.01 of a -$10.00 code, scaled to -$0.05: the small share truncates to
    // $0, the writer would drop that allocation, and its counter would fall.
    expect(
      scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -999], ["partner", -1]])], -1_000, -5),
    ).toBeNull();
    // CONTROL: a free-nights share at $0 still records the nights it used, so it stays.
    expect(
      scaleCarriedRedemptions([redemption("r1", -1_000, [["owner", -999], ["partner", -1, 1]])], -1_000, -5),
    ).not.toBeNull();
  });

  it("scales nothing where the records do not add up to the stored figure, or there are none", () => {
    expect(scaleCarriedRedemptions([redemption("r1", -3_000, [["owner", -3_000]])], -5_000, -1_000)).toBeNull();
    expect(scaleCarriedRedemptions([], -5_000, -1_000)).toBeNull();
  });
});

describe("scaleCappedCarriedRows: the one rule-derived amount (#4317, owner decision 24 Oct 2026 on #4302)", () => {
  const N1 = new Date("2026-08-01T00:00:00.000Z");
  const N2 = new Date("2026-08-02T00:00:00.000Z");
  const N3 = new Date("2026-08-03T00:00:00.000Z");
  const row = (
    stayDate: Date | null,
    amountCents: number | null,
    extra: Partial<{ bookingGuestId: string; beneficiaryMemberId: string; promoRedemptionId: string; heldPriceCents: number | null }> = {},
  ) => ({
    kind: "PROMO" as const,
    amountCents,
    promoRedemptionId: "redemption-1",
    promoCodeId: "promo-1",
    beneficiaryMemberId: "booker",
    bookingGuestId: "guest-a",
    stayDate,
    heldPriceCents: 10_000,
    ...extra,
  });
  const recorded = (priceAdjustmentCents: number, allocations: Array<[string | null, number]>, id = "redemption-1") => ({
    id,
    priceAdjustmentCents,
    allocations: allocations.map(([memberId, cents]) => ({ memberId, priceAdjustmentCents: cents })),
  });

  it("scales a fixed code's guest row to its capped figure: -$350 becomes -$300", () => {
    expect(
      scaleCappedCarriedRows([row(null, -35_000, { heldPriceCents: 30_000 })], [recorded(-30_000, [["booker", -30_000]])]),
    ).toEqual([-30_000]);
  });

  it("keeps rows that already add up byte for byte: a 100% code cut to the nights left", () => {
    expect(
      scaleCappedCarriedRows([row(N1, -5_000), row(N2, -5_000)], [recorded(-10_000, [["booker", -10_000]])]),
    ).toEqual([-5_000, -5_000]);
  });

  it("scales in proportion to the stored rows, leftover cents on the earliest night", () => {
    // -$25.00 / -$25.00 / -$50.00 scaled to -$100.01: -25.0025, -25.0025, -50.005.
    expect(
      scaleCappedCarriedRows(
        [row(N3, -5_000), row(N2, -2_500), row(N1, -2_500)],
        [recorded(-10_001, [["booker", -10_001]])],
      ),
    ).toEqual([-5_000, -2_500, -2_501]);
  });

  it("puts a night before a guest-scope row when the leftover cent goes", () => {
    expect(
      scaleCappedCarriedRows([row(null, -1_000), row(N2, -1_000)], [recorded(-1_001, [["booker", -1_001]])]),
    ).toEqual([-500, -501]);
  });

  it("scales each beneficiary to their own allocation, and each code on its own", () => {
    const scaled = scaleCappedCarriedRows(
      [
        row(N1, -4_000),
        row(N2, -4_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
        row(N1, -2_000, { promoRedemptionId: "redemption-2", bookingGuestId: "guest-b" }),
      ],
      [
        recorded(-5_000, [["booker", -2_000], ["partner", -3_000]]),
        recorded(-1_000, [["booker", -1_000]], "redemption-2"),
      ],
    );
    expect(scaled).toEqual([-2_000, -3_000, -1_000]);
  });

  it("scales a beneficiary the cap left with nothing to zero", () => {
    expect(
      scaleCappedCarriedRows(
        [row(N1, -4_000), row(N2, -1_000, { beneficiaryMemberId: "partner" })],
        [recorded(-2_000, [["booker", -2_000]])],
      ),
    ).toEqual([-2_000, 0]);
  });

  describe("writes no row for a code it cannot scale honestly (round 6), and leaves the other codes", () => {
    it("LENS 1, a 50% code across two members: scaling the booker up would take $150 off a $100 night", () => {
      // The booker kept one $100 night (-$50 stored), the partner two; the cap
      // left each member -$150. The partner's rows could carry theirs; the
      // booker's one night cannot carry -$150, so the code writes none.
      const scaled = scaleCappedCarriedRows(
        [
          row(N1, -5_000),
          row(N1, -5_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
          row(N2, -5_000, { beneficiaryMemberId: "partner", bookingGuestId: "guest-b" }),
        ],
        [recorded(-30_000, [["booker", -15_000], ["partner", -15_000]])],
      );
      expect(scaled).toEqual([null, null, null]);
    });

    it("LENS 2, an assigned fixed code: a guest row may not take more than the guest's own total", () => {
      // The engine's rule is min(value, guest total): guest A, now $100, cannot
      // carry the -$200 the cap left the booker once guest B's row went.
      expect(
        scaleCappedCarriedRows(
          [row(null, -30_000, { heldPriceCents: 10_000 })],
          [recorded(-20_000, [["booker", -20_000]])],
        ),
      ).toEqual([null]);
    });

    it("LENS 3, a SET_PRICE code that raised one night and discounted another: no proportion is meaningful", () => {
      expect(
        scaleCappedCarriedRows([row(N1, 2_000), row(N2, -5_000)], [recorded(-2_100, [["booker", -2_100]])]),
      ).toEqual([null, null]);
    });

    it("a raise is never scaled further up", () => {
      expect(scaleCappedCarriedRows([row(N1, 2_000)], [recorded(3_000, [["booker", 3_000]])])).toEqual([null]);
    });

    it("a NOT KNOWN amount, or an allocation with no row left, writes none for that code only", () => {
      const rows = [row(N1, null), row(N1, -2_000, { promoRedemptionId: "redemption-2", bookingGuestId: "guest-b" })];
      const codes = [recorded(-3_000, [["booker", -3_000]]), recorded(-1_000, [["booker", -1_000]], "redemption-2")];
      // The second code keeps KNOWN rows, and with them its own Xero line (INV-MONEY-040).
      expect(scaleCappedCarriedRows(rows, codes)).toEqual([null, -1_000]);
      expect(scaleCappedCarriedRows([], [recorded(-3_000, [["booker", -3_000]])])).toEqual([]);
    });

    it("a row naming no code the booking carries is not written", () => {
      expect(scaleCappedCarriedRows([row(N1, -5_000, { promoRedemptionId: "gone" })], [])).toEqual([null]);
    });
  });
});

describe("carriedCapRowScaler: the scaler the save hands the writer (round 6)", () => {
  it("none where the plan capped nothing, the scale where the records were scaled, and a clear where not", () => {
    expect(carriedCapRowScaler(undefined)).toBeUndefined();
    expect(carriedCapRowScaler(true)).toBe(scaleCappedCarriedRows);
    // Records left unscaled: rows that already reconcile to them are still
    // cleared, because the booking's own figure was capped beneath them.
    const clear = carriedCapRowScaler(false)!;
    const row = { kind: "PROMO" as const, amountCents: -5_000, promoRedemptionId: "r", promoCodeId: "c", beneficiaryMemberId: "m", bookingGuestId: "g", stayDate: null, heldPriceCents: 9_000 };
    const recorded = [{ id: "r", priceAdjustmentCents: -5_000, allocations: [{ memberId: "m", priceAdjustmentCents: -5_000 }] }];
    expect(clear([row], recorded)).toEqual([null]);
    expect(carriedCapRowScaler(true)!([row], recorded)).toEqual([-5_000]);
  });
});
