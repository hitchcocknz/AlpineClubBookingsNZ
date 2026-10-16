import { describe, expect, it } from "vitest";

import { parseDateOnly } from "@/lib/date-only";
import {
  deltaHasStayRangeInputs,
  resolveModificationStayRanges,
} from "@/lib/booking-modification-stay-ranges";
import { buildModificationProposalParties } from "@/lib/booking-exception-request-service";

/**
 * The contract that makes the booking-policy exception workflow sound (#2526):
 * the party frozen for an officer to review is the party the canonical
 * modification planner will build from the same delta.
 *
 * These tests drive the SHARED resolver — the one `resolveTargetDates` and
 * `prepareGuestPlan` now call — and compare it against the frozen proposal, so a
 * future change that moves one and not the other reddens here rather than
 * shipping a proposal nobody executed.
 */

const BOOKING_CHECK_IN = parseDateOnly("2026-08-01");
const BOOKING_CHECK_OUT = parseDateOnly("2026-08-03");

function guest(id: string, start: string, end: string, nights?: string[]) {
  return {
    id,
    firstName: id.toUpperCase(),
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: false,
    memberId: null,
    stayStart: parseDateOnly(start),
    stayEnd: parseDateOnly(end),
    ...(nights
      ? { nights: nights.map((night) => ({ stayDate: parseDateOnly(night) })) }
      : {}),
  };
}

/** The nights the frozen proposal claims for each guest, by guest name. */
function frozenNightsByGuest(
  liveGuests: ReturnType<typeof guest>[],
  delta: Parameters<typeof buildModificationProposalParties>[0]["delta"],
) {
  const { proposed } = buildModificationProposalParties({
    bookingCheckIn: BOOKING_CHECK_IN,
    bookingCheckOut: BOOKING_CHECK_OUT,
    liveGuests,
    delta,
  });
  return {
    envelope: [proposed.checkIn, proposed.checkOut],
    byGuest: Object.fromEntries(
      proposed.guests.map((g) => [`${g.firstName} ${g.lastName}`, g.nights]),
    ),
  };
}

describe("the global range-input flag decides the whole request", () => {
  it("switches on ANY range anywhere, and on nothing else", () => {
    // The one predicate the whole resolution hinges on, pinned as a table so the
    // "any range anywhere" reading cannot quietly narrow to "any range on THIS
    // guest" — which is the shape of the bug this module was written to close.
    // A range entry that carries no dates and no nights is NOT a range input.
    // `resolvable: false` marks an input the predicate accepts as a range input
    // but the resolver then REFUSES (a half-supplied range) — the refusal itself
    // is pinned further down. Everything else is resolved as well, so the flag the
    // resolver acted on is checked against the predicate that decided it.
    const cases: Array<[Record<string, unknown>, boolean, boolean?]> = [
      [{}, false],
      [{ guestStayRanges: [{ guestId: "a" }] }, false],
      [{ addGuests: [{}] }, false],
      [{ checkIn: "2026-08-02", checkOut: "2026-08-05" }, false],
      [
        {
          guestStayRanges: [
            { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-02" },
          ],
        },
        true,
      ],
      [{ guestStayRanges: [{ guestId: "a", stayStart: "2026-08-01" }] }, true, false],
      [{ guestStayRanges: [{ guestId: "a", nights: ["2026-08-02"] }] }, true],
      [{ addGuests: [{ stayStart: "2026-08-01", stayEnd: "2026-08-04" }] }, true],
      // A range on a guest who is NOT the one being asked about still switches
      // the mode for everybody.
      [
        {
          removeGuestIds: ["z"],
          guestStayRanges: [
            { guestId: "z", stayStart: "2026-08-01", stayEnd: "2026-08-02" },
          ],
        },
        true,
      ],
    ];
    for (const [input, expected, resolvable = true] of cases) {
      expect(deltaHasStayRangeInputs(input as never), JSON.stringify(input)).toBe(
        expected,
      );
      if (!resolvable) continue;
      // And the resolver reports the same flag it acted on.
      const resolved = resolveModificationStayRanges({
        booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
        guests: [guest("a", "2026-08-01", "2026-08-03")],
        input: input as never,
      });
      expect(resolved.hasRangeInputs, JSON.stringify(input)).toBe(expected);
    }
  });

  it("a dates change WITH a partial range leaves the other guests on their stored nights", () => {
    // THE DIVERGENCE THAT MADE THIS MODULE NECESSARY. The old frozen model reset
    // every guest with no range entry to the new envelope whenever the dates
    // moved; the planner keeps them on their stored nights because SOME range
    // input was supplied. An officer therefore approved a 3-guest x 3-night party
    // and the execution built 3 + 2 + 2 guest-nights: a different party, a
    // different price, and a hosting/minimum-stay judgement made on a party that
    // was never created.
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
      guest("c", "2026-08-01", "2026-08-03"),
    ];
    const delta = {
      checkOut: "2026-08-04",
      guestStayRanges: [
        { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-04" },
      ],
    };

    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: liveGuests,
      input: delta,
    });
    expect(resolved.hasRangeInputs).toBe(true);
    // Only guest A moved; B and C kept their stored two nights.
    expect(resolved.remaining.map((entry) => entry.guest.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(resolved.remaining[1].stayEnd.toISOString().slice(0, 10)).toBe(
      "2026-08-03",
    );
    expect(resolved.remaining[2].stayEnd.toISOString().slice(0, 10)).toBe(
      "2026-08-03",
    );

    // And the FROZEN proposal says exactly the same thing.
    const frozen = frozenNightsByGuest(liveGuests, delta);
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(frozen.byGuest["B Guest"]).toEqual(["2026-08-01", "2026-08-02"]);
    expect(frozen.byGuest["C Guest"]).toEqual(["2026-08-01", "2026-08-02"]);
    // 7 guest-nights, not 9.
    expect(
      Object.values(frozen.byGuest).reduce((sum, nights) => sum + nights.length, 0),
    ).toBe(7);
  });

  it("a dates change with NO range input DOES reset every remaining guest", () => {
    // The other branch, unchanged: without any range input a date move resets
    // everybody, which is the behaviour the planner has always had.
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
    ];
    const frozen = frozenNightsByGuest(liveGuests, { checkOut: "2026-08-04" });
    expect(frozen.envelope).toEqual(["2026-08-01", "2026-08-04"]);
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
    expect(frozen.byGuest["B Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
});

describe("a stored sparse night set survives the freeze", () => {
  it("preserves the gap instead of flattening it to the envelope", () => {
    // The old model expanded stayStart..stayEnd, so a guest booked for the 1st
    // and the 3rd was frozen as staying the 1st, 2nd AND 3rd — claiming a bed on
    // a night the execution never books, and pricing it.
    const sparse = guest("a", "2026-08-01", "2026-08-04", [
      "2026-08-01",
      "2026-08-03",
    ]);
    const frozen = frozenNightsByGuest([sparse], {});
    expect(frozen.byGuest["A Guest"]).toEqual(["2026-08-01", "2026-08-03"]);
  });

  it("still resets a sparse guest when a bare date change resets everybody", () => {
    const sparse = guest("a", "2026-08-01", "2026-08-04", [
      "2026-08-01",
      "2026-08-03",
    ]);
    const frozen = frozenNightsByGuest([sparse], { checkOut: "2026-08-02" });
    expect(frozen.byGuest["A Guest"]).toEqual(["2026-08-01"]);
  });
});

describe("the envelope expands to cover the resolved ranges", () => {
  it("widens past the requested check-out when a guest range reaches further", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [guest("a", "2026-08-01", "2026-08-03")],
      input: {
        guestStayRanges: [
          { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-10" },
        ],
      },
    });
    expect(resolved.checkOut.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(resolved.datesChanged).toBe(true);
  });

  it("leaves the envelope alone when no range input is supplied", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [guest("a", "2026-08-01", "2026-08-03")],
      input: {},
    });
    expect(resolved.hasRangeInputs).toBe(false);
    expect(resolved.datesChanged).toBe(false);
    expect(resolved.checkIn.getTime()).toBe(BOOKING_CHECK_IN.getTime());
    expect(resolved.checkOut.getTime()).toBe(BOOKING_CHECK_OUT.getTime());
  });
});

describe("a delta the canonical planner would refuse is refused at freeze time", () => {
  it("throws on a half-supplied range rather than completing it from the envelope", () => {
    // `normalizeGuestStayRange` refuses a Date In with no Date Out, so the
    // canonical service would answer 400. The old model silently filled the
    // missing half from the new envelope and froze a proposal that could never be
    // executed.
    expect(() =>
      buildModificationProposalParties({
        bookingCheckIn: BOOKING_CHECK_IN,
        bookingCheckOut: BOOKING_CHECK_OUT,
        liveGuests: [guest("a", "2026-08-01", "2026-08-03")],
        delta: { guestStayRanges: [{ guestId: "a", stayStart: "2026-08-02" }] },
      }),
    ).toThrow(/both required/i);
  });

  it("treats a range entry with BOTH sides absent as no range at all", () => {
    // `{ guestId }` with nothing on it is not a range input, so the request stays
    // in the no-range branch — which is what the planner's predicate says too.
    const liveGuests = [guest("a", "2026-08-01", "2026-08-03")];
    const frozen = frozenNightsByGuest(liveGuests, {
      checkOut: "2026-08-04",
      guestStayRanges: [{ guestId: "a" }],
    });
    expect(frozen.byGuest["A Guest"]).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
    ]);
  });
});

describe("removals and additions", () => {
  it("drops removed guests and lands added ones on the resolved envelope", () => {
    const liveGuests = [
      guest("a", "2026-08-01", "2026-08-03"),
      guest("b", "2026-08-01", "2026-08-03"),
    ];
    const frozen = frozenNightsByGuest(liveGuests, {
      removeGuestIds: ["b"],
      addGuests: [
        {
          firstName: "New",
          lastName: "Person",
          ageTier: "ADULT",
          isMember: false,
        },
      ],
    });
    expect(Object.keys(frozen.byGuest).sort()).toEqual(["A Guest", "New Person"]);
    expect(frozen.byGuest["New Person"]).toEqual(["2026-08-01", "2026-08-02"]);
  });

  it("does not let a removed guest's stored range widen the envelope", () => {
    const resolved = resolveModificationStayRanges({
      booking: { checkIn: BOOKING_CHECK_IN, checkOut: BOOKING_CHECK_OUT },
      guests: [
        guest("a", "2026-08-01", "2026-08-03"),
        guest("b", "2026-08-01", "2026-08-20"),
      ],
      input: {
        removeGuestIds: ["b"],
        guestStayRanges: [
          { guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-03" },
        ],
      },
    });
    expect(resolved.checkOut.toISOString().slice(0, 10)).toBe("2026-08-03");
  });
});

describe("#4189 a range that only repeats a gapped guest's own dates keeps their nights (INV-MOD-062)", () => {
  // The direct editor's range mode (per-guest dates on, night grid off) sends
  // EVERY remaining guest's Date In and Date Out, and cannot carry a gap. Before
  // #4189 the resolver normalised that entry from its bounds alone, so an
  // untouched guest holding the 1st and 3rd was put on the 2nd as well, and
  // charged for it. #4157's rule (`nightsKeptByRepeatedRange`) now decides it.
  const STAY = { checkIn: parseDateOnly("2026-08-01"), checkOut: parseDateOnly("2026-08-04") };
  const GAPPED = ["2026-08-01", "2026-08-03"];
  const REPEAT = { stayStart: "2026-08-01", stayEnd: "2026-08-04" };

  function resolve(
    guests: ReturnType<typeof guest>[],
    input: Parameters<typeof resolveModificationStayRanges>[0]["input"],
  ) {
    const resolved = resolveModificationStayRanges({ booking: STAY, guests, input });
    const nights = Object.fromEntries(
      resolved.remaining.map((entry) => [
        entry.guest.id,
        entry.nights ? entry.nights.map((night) => night.toISOString().slice(0, 10)).sort() : null,
      ]),
    );
    const { proposed } = buildModificationProposalParties({
      bookingCheckIn: STAY.checkIn,
      bookingCheckOut: STAY.checkOut,
      liveGuests: guests,
      delta: input as Parameters<typeof buildModificationProposalParties>[0]["delta"],
    });
    const frozen = Object.fromEntries(proposed.guests.map((g) => [g.firstName.toLowerCase(), g.nights]));
    return { resolved, nights, frozen };
  }

  it("an untouched gapped guest keeps their gap, and the frozen proposal agrees", () => {
    const { resolved, nights, frozen } = resolve([guest("a", "2026-08-01", "2026-08-04", GAPPED)], {
      guestStayRanges: [{ guestId: "a", ...REPEAT }],
    });
    expect(nights.a, "INV-MOD-062: a repeated range keeps the nights held").toEqual(GAPPED);
    expect(frozen.a).toEqual(GAPPED);
    expect(resolved.datesChanged).toBe(false);
    expect([resolved.checkIn, resolved.checkOut]).toEqual([STAY.checkIn, STAY.checkOut]);
  });

  it("a stored delta replayed with Date bounds keeps them too", () => {
    const { nights } = resolve([guest("a", "2026-08-01", "2026-08-04", GAPPED)], {
      guestStayRanges: [{ guestId: "a", stayStart: STAY.checkIn, stayEnd: STAY.checkOut }],
    });
    expect(nights.a).toEqual(GAPPED);
  });

  it("a really moved bound re-spreads the guest over a continuous stay", () => {
    const { nights, frozen } = resolve([guest("a", "2026-08-01", "2026-08-04", GAPPED)], {
      guestStayRanges: [{ guestId: "a", stayStart: "2026-08-01", stayEnd: "2026-08-05" }],
    });
    expect(nights.a).toBeNull();
    expect(frozen.a).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
  });

  it("a mixed party: the repeated gapped guest keeps, the moved one re-spreads, the full one is unchanged", () => {
    const { resolved, nights, frozen } = resolve(
      [
        guest("a", "2026-08-01", "2026-08-04", GAPPED),
        guest("b", "2026-08-01", "2026-08-04", GAPPED),
        guest("c", "2026-08-01", "2026-08-04", ["2026-08-01", "2026-08-02", "2026-08-03"]),
      ],
      {
        guestStayRanges: [
          { guestId: "a", ...REPEAT },
          { guestId: "b", stayStart: "2026-08-02", stayEnd: "2026-08-05" },
          { guestId: "c", ...REPEAT },
        ],
      },
    );
    expect(nights).toEqual({ a: GAPPED, b: null, c: null });
    expect(frozen).toEqual({
      a: GAPPED,
      b: ["2026-08-02", "2026-08-03", "2026-08-04"],
      c: ["2026-08-01", "2026-08-02", "2026-08-03"],
    });
    expect(resolved.checkOut).toEqual(parseDateOnly("2026-08-05"));
  });

  it("a grid night set is applied exactly as chosen, gap filled or not", () => {
    const filled = resolve([guest("a", "2026-08-01", "2026-08-04", GAPPED)], {
      guestStayRanges: [{ guestId: "a", nights: ["2026-08-01", "2026-08-02", "2026-08-03"] }],
    });
    expect(filled.nights.a).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    const kept = resolve([guest("a", "2026-08-01", "2026-08-04", GAPPED)], {
      guestStayRanges: [{ guestId: "a", nights: ["2026-08-03"] }],
    });
    expect(kept.nights.a).toEqual(["2026-08-03"]);
  });

  it("still refuses a malformed entry before the rule is read", () => {
    expect(() =>
      resolveModificationStayRanges({
        booking: STAY,
        guests: [guest("a", "2026-08-01", "2026-08-04", GAPPED)],
        input: { guestStayRanges: [{ guestId: "a", stayStart: "2026-08-01" }] },
      }),
    ).toThrow(/Date In and Date Out are both required/);
  });
});
