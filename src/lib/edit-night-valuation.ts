import type { BookingGuestNightPriceSource, MemberGuestConsentStatus } from "@prisma/client";

import {
  getGuestBedNightKeys,
  type BookingStayRange,
} from "@/lib/booking-guest-stay-ranges";
import type { StrandNightPrices } from "@/lib/booking-strand-night-prices";
import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import { parseDateOnly } from "@/lib/date-only";
import {
  storedNightPriceDetailsByKey,
  type StoredNightPriceInput,
  type StoredNightPriceWithSource,
} from "@/lib/stored-night-price-write";
import {
  valueStrandNights,
  type ValuedStrandNight,
} from "@/lib/strand-night-valuation";

/**
 * #4317 (epic #4302, owner decisions D1, D8 and D11, 23 Oct 2026): WHAT AN EDIT
 * READS A GUEST'S HELD NIGHTS AS BEING WORTH.
 *
 * Every edit is priced from stored data (`INV-MOD-028`). The night values come
 * from `valueStrandNights`, the one home for the rule; this module only adapts
 * them to the shapes the edit doors price with, so no door states the rule
 * again (`INV-SSOT-001`):
 *
 * - **Locks.** Every night a guest holds is handed to pricing at its valued
 *   figure, so a night the guest keeps keeps that figure and a night given back
 *   is credited at it. Only a night the edit newly buys is priced at today's
 *   rates. This replaces the lenient `lockedNightPricesForGuest`, which locked
 *   only usable rows and let a blank night fall through to today's rate.
 * - **Money not attached to a night.** The values add up to the guest's stored
 *   total, except in two shapes: a negative stored total, whose nights are all
 *   worth $0 (D11, flagged for #2745), and a strand holding no night at all.
 *   `unattachedCents` is what such a strand carries beyond its night values, and
 *   an edit keeps it on the strand, so a guest the edit does not touch keeps its
 *   stored total exactly (T1).
 * - **Removing a whole guest** credits `BookingGuest.priceCents` (T2), or $0 for
 *   a negative stored total (D11): `removalCreditCents`.
 *
 * Night keys come from `getGuestBedNightKeys`, the canonical helper: a guest's
 * own rows where it has any, otherwise its stay envelope, otherwise the
 * booking's range (`INV-DATE-020`). No clock, no database, no rate table; the
 * one side effect, the D11 flag, writes to the logger its caller hands in.
 */

/** One held night with what an edit reads it as worth. */
export type ValuedHeldNight = {
  date: CalendarDate;
  valueCents: number;
  /**
   * The provenance a rewritten row records: the stored one where the row is
   * the value, `EVEN_SPLIT` for a share of a split, `UNKNOWN` for a night
   * valued at $0 because its strand's total is negative.
   */
  priceSource: BookingGuestNightPriceSource;
};

export type ValuedEditStrand = {
  /** Every night the guest holds, in the order of the keys given. */
  nights: ReadonlyArray<ValuedHeldNight>;
  /**
   * The stored total less what its nights are valued at. Zero except on a
   * negative stored total (D11) or a strand holding no night with money on it.
   */
  unattachedCents: number;
  /** What removing the whole guest credits: the stored total, or $0 if negative. */
  removalCreditCents: number;
  /** Set on a negative stored total, for #2745 (D11). */
  flag: "NEGATIVE_STORED_TOTAL" | null;
};

/**
 * What removing a whole guest credits (T2): `BookingGuest.priceCents`, or $0
 * where that total is negative (D11) — never a charge for leaving.
 */
export function strandRemovalCreditCents(storedTotalCents: number): number {
  return Math.max(storedTotalCents, 0);
}

function sourceOf(
  night: ValuedStrandNight,
  stored: StoredNightPriceWithSource | undefined,
): BookingGuestNightPriceSource {
  switch (night.basis) {
    case "STORED_ROW":
      return stored?.priceSource ?? "UNKNOWN";
    case "SPLIT":
      return "EVEN_SPLIT";
    case "NEGATIVE_TOTAL":
      return "UNKNOWN";
    default: {
      const unhandled: never = night.basis;
      throw new Error(`edit-night-valuation: unhandled basis ${String(unhandled)}`);
    }
  }
}

/**
 * Value one strand from the night keys it holds and what is stored against
 * them. The planner already holds both, keyed through the canonical helpers,
 * so it calls this directly; every other caller goes through
 * {@link valueEditStrand}.
 */
export function valueHeldNights(
  heldNightKeys: readonly string[],
  storedNightDetailsByKey: ReadonlyMap<string, StoredNightPriceWithSource>,
  storedTotalCents: number,
): ValuedEditStrand {
  const removalCreditCents = strandRemovalCreditCents(storedTotalCents);
  if (heldNightKeys.length === 0 && storedTotalCents >= 0) {
    // Nothing to attach the money to. It stays on the strand while the strand
    // does, and a whole removal credits it (T2).
    return {
      nights: [],
      unattachedCents: storedTotalCents,
      removalCreditCents,
      flag: null,
    };
  }
  const valuation = valueStrandNights(
    heldNightKeys.map((key) => ({
      date: requireCalendarDate(key),
      priceCents: storedNightDetailsByKey.get(key)?.priceCents ?? null,
      priceSource: storedNightDetailsByKey.get(key)?.priceSource,
    })),
    storedTotalCents,
  );
  return {
    nights: valuation.nights.map((night) => ({
      date: night.date,
      valueCents: night.valueCents,
      priceSource: sourceOf(night, storedNightDetailsByKey.get(night.date)),
    })),
    unattachedCents: storedTotalCents - valuation.totalCents,
    removalCreditCents,
    flag: valuation.flag,
  };
}

/** The stored shape every edit door already loads for a guest. */
export type StoredEditStrand = {
  priceCents: number;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  nights?: ReadonlyArray<StoredNightPriceInput> | null;
};

/** {@link valueHeldNights} for a guest as loaded, keyed by the canonical helper. */
export function valueEditStrand(
  guest: StoredEditStrand,
  booking: BookingStayRange,
): ValuedEditStrand {
  return valueHeldNights(
    getGuestBedNightKeys(guest, booking),
    storedNightPriceDetailsByKey(guest.nights),
    guest.priceCents,
  );
}

/** A lock the pricing engine reads (`lockedNightPrices`), one per held night. */
export type ValuedNightLock = {
  stayDate: Date;
  priceCents: number;
  priceSource: BookingGuestNightPriceSource;
};

/**
 * The locks and the unattached money one existing guest prices an edit with.
 * Every held night is locked at its value, so only a night the edit buys
 * reaches a season rate.
 */
export function valuedNightLocksForGuest(
  guest: StoredEditStrand,
  booking: BookingStayRange,
): { lockedNightPrices: ValuedNightLock[]; unattachedCents: number } {
  const valued = valueEditStrand(guest, booking);
  return {
    lockedNightPrices: valued.nights.map((night) => ({
      stayDate: parseDateOnly(night.date),
      priceCents: night.valueCents,
      priceSource: night.priceSource,
    })),
    unattachedCents: valued.unattachedCents,
  };
}

/**
 * Put each strand's unattached money back into a breakdown the pricing engine
 * produced from valued locks, and keep on the booking what a removed negative
 * strand carried (D11).
 *
 * `pricedGuests` is index-aligned with the breakdown: an existing guest's
 * `unattachedCents`, or nothing for a guest the edit adds. `removed` is every
 * guest the edit takes off the booking whole. With no negative or night-less
 * strand on the booking, every term is zero and the breakdown comes back
 * unchanged.
 */
export function withUnattachedStrandMoney<
  Breakdown extends {
    totalPriceCents: number;
    guests: ReadonlyArray<{ priceCents: number }>;
  },
>(
  breakdown: Breakdown,
  // `& object` so a guest the edit adds, which carries no field of this shape
  // at all, is accepted rather than refused as a "weak type" mismatch.
  pricedGuests: ReadonlyArray<{ unattachedCents?: number } & object>,
  removed: ReadonlyArray<StoredEditStrand>,
): Breakdown {
  const retainedOnRemoval = removed.reduce(
    (sum, guest) => sum + (guest.priceCents - strandRemovalCreditCents(guest.priceCents)),
    0,
  );
  const unattached = pricedGuests.map((guest) => guest.unattachedCents ?? 0);
  if (unattached.every((cents) => cents === 0) && retainedOnRemoval === 0) {
    // Nothing to add: the breakdown is returned as the engine produced it, so a
    // caller's own check of its shape still answers a malformed one.
    return breakdown;
  }
  if (pricedGuests.length !== breakdown.guests.length) {
    throw new Error(
      `withUnattachedStrandMoney: ${pricedGuests.length} pricing inputs for ${breakdown.guests.length} priced guests (#4317).`,
    );
  }
  const totalUnattached = unattached.reduce((sum, cents) => sum + cents, 0);
  return {
    ...breakdown,
    totalPriceCents: breakdown.totalPriceCents + totalUnattached + retainedOnRemoval,
    guests: breakdown.guests.map((guest, index) => ({
      ...guest,
      priceCents: guest.priceCents + (unattached[index] ?? 0),
    })),
  };
}

/**
 * Each guest's nights as the money a promotion is re-decided over, valued by
 * the same rule an edit prices with — for a re-price that moves only the
 * promotion (a guest's acceptance, #3827). Sorted by date so the rates and
 * dates are parallel and in stay order.
 */
export function valuedStrandNightPrices(
  guests: ReadonlyArray<
    StoredEditStrand & {
      id: string;
      memberId: string | null;
      isMember: boolean;
      consentStatus: MemberGuestConsentStatus | null;
    }
  >,
  booking: BookingStayRange,
): StrandNightPrices[] {
  return guests.map((guest) => {
    const nights = [...valueEditStrand(guest, booking).nights].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
    return {
      bookingGuestId: guest.id,
      memberId: guest.memberId,
      isMember: guest.isMember,
      consentStatus: guest.consentStatus,
      perNightRates: nights.map((night) => night.valueCents),
      nightDates: nights.map((night) => parseDateOnly(night.date)),
    };
  });
}

/**
 * D11's flag: an edit that valued a negative stored guest total at $0 says so,
 * once per edit, naming the guests, so #2745 can find the booking. The edit
 * itself goes ahead. The logger is the caller's, which keeps this module pure.
 */
export function flagNegativeStoredTotals(
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
  context: { bookingId: string; site: string },
  guests: ReadonlyArray<{ id: string; priceCents: number }>,
): void {
  const bookingGuestIds = guests
    .filter((guest) => guest.priceCents < 0)
    .map((guest) => guest.id);
  if (bookingGuestIds.length === 0) return;
  log.warn(
    { ...context, bookingGuestIds, flag: "NEGATIVE_STORED_TOTAL" },
    "A booking edit valued a negative stored guest total at $0 (D11); flagged for #2745",
  );
}
