import { describe, expect, it, vi } from "vitest";

import {
  flagNegativeStoredTotals,
  strandRemovalCreditCents,
  valueEditStrand,
  valueHeldNights,
  valuedNightLocksForGuest,
  valuedStrandNightPrices,
  withUnattachedStrandMoney,
} from "@/lib/edit-night-valuation";

/**
 * #4317 (epic #4302, owner decisions D1 and D11): what an edit reads a guest's
 * held nights as being worth, in the shapes the edit doors price with.
 *
 * `valueStrandNights` owns the rule and has its own suite; this one pins the
 * adapter every door goes through — which nights are held, which provenance a
 * rewritten row records, the money a strand carries beyond its nights, and how
 * that money is put back into an engine breakdown — in dollar figures.
 */

const BOOKING = {
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-04T00:00:00.000Z"),
};

function night(
  date: string,
  priceCents: number | null,
  priceSource: "SOLD" | "EVEN_SPLIT" | "UNKNOWN" | "RATE_DERIVED" | "OFFICER_PRICED" = "SOLD",
) {
  return { stayDate: new Date(`${date}T00:00:00.000Z`), priceCents, priceSource };
}

describe("valueEditStrand: each held night's value and the row it rewrites to", () => {
  it("R1: rows that add up to the stored total are the values, keeping their provenance", () => {
    const valued = valueEditStrand(
      {
        priceCents: 9_000,
        nights: [night("2026-08-01", 4_000, "SOLD"), night("2026-08-02", 5_000, "EVEN_SPLIT")],
      },
      BOOKING,
    );
    expect(valued.nights).toEqual([
      { date: "2026-08-01", valueCents: 4_000, priceSource: "SOLD" },
      { date: "2026-08-02", valueCents: 5_000, priceSource: "EVEN_SPLIT" },
    ]);
    expect(valued.unattachedCents).toBe(0);
    expect(valued.removalCreditCents).toBe(9_000);
    expect(valued.flag).toBeNull();
  });

  it("R2: a usable row keeps its figure; the rest of $100 is split over the blanks", () => {
    const valued = valueEditStrand(
      {
        priceCents: 10_000,
        nights: [
          night("2026-08-01", 4_000, "SOLD"),
          night("2026-08-02", null, "UNKNOWN"),
          night("2026-08-03", null, "UNKNOWN"),
        ],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [4_000, "SOLD"],
      [3_000, "EVEN_SPLIT"],
      [3_000, "EVEN_SPLIT"],
    ]);
    expect(valued.unattachedCents).toBe(0);
  });

  it("R3: rows over the total are discarded and $100 is split, leftover cent first", () => {
    const valued = valueEditStrand(
      {
        priceCents: 10_000,
        nights: [
          night("2026-08-01", 6_000, "SOLD"),
          night("2026-08-02", null, "UNKNOWN"),
          night("2026-08-03", 6_000, "SOLD"),
        ],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [3_334, "EVEN_SPLIT"],
      [3_333, "EVEN_SPLIT"],
      [3_333, "EVEN_SPLIT"],
    ]);
    expect(valued.unattachedCents).toBe(0);
  });

  it("a guest with no rows is valued over its stay envelope (INV-DATE-020)", () => {
    const valued = valueEditStrand(
      {
        priceCents: 9_001,
        stayStart: new Date("2026-08-02T00:00:00.000Z"),
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
        nights: [],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.date, n.valueCents])).toEqual([
      ["2026-08-02", 4_501],
      ["2026-08-03", 4_500],
    ]);
  });

  it("D11: a negative stored total values every night at $0, flags it and credits $0", () => {
    const valued = valueEditStrand(
      {
        priceCents: -500,
        nights: [night("2026-08-01", 4_000), night("2026-08-02", 4_000)],
      },
      BOOKING,
    );
    expect(valued.nights.map((n) => [n.valueCents, n.priceSource])).toEqual([
      [0, "UNKNOWN"],
      [0, "UNKNOWN"],
    ]);
    // The -$5 is carried on the strand, not on a night, so a guest the edit
    // does not touch keeps its stored total exactly.
    expect(valued.unattachedCents).toBe(-500);
    expect(valued.removalCreditCents).toBe(0);
    expect(valued.flag).toBe("NEGATIVE_STORED_TOTAL");
  });
});

describe("valueHeldNights: a strand holding no night", () => {
  it("keeps a $70 total unattached and credits all of it on removal", () => {
    expect(valueHeldNights([], new Map(), 7_000)).toEqual({
      nights: [],
      unattachedCents: 7_000,
      removalCreditCents: 7_000,
      flag: null,
    });
  });

  it("keeps a negative total unattached, credits $0 and flags it", () => {
    const valued = valueHeldNights([], new Map(), -300);
    expect(valued.nights).toEqual([]);
    expect(valued.unattachedCents).toBe(-300);
    expect(valued.removalCreditCents).toBe(0);
    expect(valued.flag).toBe("NEGATIVE_STORED_TOTAL");
  });
});

describe("strandRemovalCreditCents (T2, D11)", () => {
  it.each([
    [12_000, 12_000],
    [0, 0],
    [-1, 0],
  ])("a stored total of %i credits %i", (stored, credit) => {
    expect(strandRemovalCreditCents(stored)).toBe(credit);
  });
});

describe("valuedNightLocksForGuest: every held night is locked at its value", () => {
  it("locks the blank night too, so no held night reaches a season rate", () => {
    const locks = valuedNightLocksForGuest(
      {
        priceCents: 9_000,
        nights: [night("2026-08-01", 4_000), night("2026-08-02", null, "UNKNOWN")],
      },
      BOOKING,
    );
    expect(locks).toEqual({
      lockedNightPrices: [
        {
          stayDate: new Date("2026-08-01T00:00:00.000Z"),
          priceCents: 4_000,
          priceSource: "SOLD",
        },
        {
          stayDate: new Date("2026-08-02T00:00:00.000Z"),
          priceCents: 5_000,
          priceSource: "EVEN_SPLIT",
        },
      ],
      unattachedCents: 0,
    });
  });
});

describe("withUnattachedStrandMoney: the engine's breakdown plus each strand's unattached money", () => {
  it("returns the engine's breakdown itself when no strand carries any", () => {
    const breakdown = { totalPriceCents: 9_000, guests: [{ priceCents: 9_000 }] };
    // Even with a misaligned input: nothing to add means nothing to check.
    expect(withUnattachedStrandMoney(breakdown, [], [])).toBe(breakdown);
  });

  it("keeps a negative strand's -$5 on it, beside a guest the edit adds at $60", () => {
    const result = withUnattachedStrandMoney(
      {
        totalPriceCents: 6_000,
        guests: [{ priceCents: 0, id: "negative" }, { priceCents: 6_000, id: "added" }],
      },
      [{ unattachedCents: -500 }, {}],
      [],
    );
    expect(result.totalPriceCents).toBe(5_500);
    expect(result.guests).toEqual([
      { priceCents: -500, id: "negative" },
      { priceCents: 6_000, id: "added" },
    ]);
  });

  it("removing a negative -$8 strand credits $0: its money stays in the total", () => {
    const result = withUnattachedStrandMoney(
      { totalPriceCents: 5_000, guests: [{ priceCents: 5_000 }] },
      [{ unattachedCents: 0 }],
      [{ priceCents: -800 }],
    );
    // Before: 5000 + (-800) = 4200. After: 4200. The removal moved nothing.
    expect(result.totalPriceCents).toBe(4_200);
    expect(result.guests).toEqual([{ priceCents: 5_000 }]);
  });

  it("a removed non-negative strand retains nothing", () => {
    const breakdown = { totalPriceCents: 5_000, guests: [{ priceCents: 5_000 }] };
    expect(withUnattachedStrandMoney(breakdown, [{ unattachedCents: 0 }], [{ priceCents: 12_000 }])).toBe(
      breakdown,
    );
  });

  it("refuses to add money to a breakdown it cannot align", () => {
    expect(() =>
      withUnattachedStrandMoney(
        { totalPriceCents: 0, guests: [{ priceCents: 0 }, { priceCents: 0 }] },
        [{ unattachedCents: -500 }],
        [],
      ),
    ).toThrow(/1 pricing inputs for 2 priced guests/);
  });
});

describe("valuedStrandNightPrices: an acceptance re-price reads the same values", () => {
  it("returns each guest's nights in stay order, valued, with parallel dates", () => {
    const [strand] = valuedStrandNightPrices(
      [
        {
          id: "guest-1",
          memberId: "member-1",
          isMember: true,
          consentStatus: null,
          priceCents: 10_000,
          nights: [
            night("2026-08-03", null, "UNKNOWN"),
            night("2026-08-01", 4_000),
            night("2026-08-02", null, "UNKNOWN"),
          ],
        },
      ],
      BOOKING,
    );
    expect(strand).toEqual({
      bookingGuestId: "guest-1",
      memberId: "member-1",
      isMember: true,
      consentStatus: null,
      perNightRates: [4_000, 3_000, 3_000],
      nightDates: [
        new Date("2026-08-01T00:00:00.000Z"),
        new Date("2026-08-02T00:00:00.000Z"),
        new Date("2026-08-03T00:00:00.000Z"),
      ],
    });
  });
});

describe("flagNegativeStoredTotals (D11)", () => {
  it("warns once, naming every negative guest, and lets the edit go ahead", () => {
    const warn = vi.fn();
    flagNegativeStoredTotals({ warn }, { bookingId: "b1", site: "test" }, [
      { id: "g1", priceCents: -1 },
      { id: "g2", priceCents: 0 },
      { id: "g3", priceCents: -900 },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      bookingId: "b1",
      site: "test",
      bookingGuestIds: ["g1", "g3"],
      flag: "NEGATIVE_STORED_TOTAL",
    });
  });

  it("says nothing when no stored total is negative", () => {
    const warn = vi.fn();
    flagNegativeStoredTotals({ warn }, { bookingId: "b1", site: "test" }, [
      { id: "g1", priceCents: 0 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });
});
