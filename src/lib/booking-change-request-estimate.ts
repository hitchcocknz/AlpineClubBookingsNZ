import type { AgeTier } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getDefaultLodgeId } from "@/lib/lodges";
import {
  normalizeGuestStayRange,
  type NormalizedBookingGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { calculateBookingPrice, getStayNights, type GuestInput } from "@/lib/pricing";
import { loadActiveSeasonRates } from "@/lib/booking-modify-plan";
import { toEditTimeGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import {
  resolveGroupDiscountRateType,
  resolveGuestRateMembershipTypes,
} from "@/lib/membership-type-policy";
import { resolveSubscriptionLockoutMode } from "@/lib/member-subscription-eligibility";
import type {
  ChangeRequestAddGuest,
  ChangeRequestEstimate,
} from "@/lib/booking-change-request-guests";

/**
 * The price shown on a member's in-progress change request before they send it
 * (#4030 Part A: "it shows the quote, as the structured route does").
 *
 * WHAT IT IS. The added NON-MEMBER guests priced night by night at the stay's
 * own active season rates by the canonical pricing engine
 * (`calculateBookingPrice`, with the canonical rate resolver and the club's
 * edit-time group discount), with every guest already on the booking counted
 * on the nights they hold — so a party that crosses the group-discount size is
 * priced as one. That is the same arithmetic the finished-stay approval's
 * ordinary pricing pass uses for an added guest (#3750), so on an unchanged
 * season it is the price approving charges. Adding guests carries no change fee.
 *
 * WHAT IT IS NOT, and the card says so:
 *  - It is an ESTIMATE: the officer's approval is what prices and charges it, at
 *    that moment's rates and with any promotion or account credit applied.
 *  - It never prices a MEMBER guest. Resolving a member's rate reads their
 *    membership type and subscription, and a member-reachable route that did that
 *    for any id it was handed would answer "is this person a paid-up member" for
 *    anyone (the D-8 boundary the member-guest finder exists to hold). A member
 *    guest's line is "priced at their membership rate when approved".
 *  - Guests already on the booking AND added member guests are COUNTED, never
 *    priced (#4030 review M5): each holds its nights as count-only locked entries
 *    at zero, so no rate is looked up for them, nothing about their price is read
 *    or returned, and the party size on each night — which decides the group
 *    discount — is the party the approval will price.
 */

export const CHANGE_REQUEST_ESTIMATE_NO_RATE_MESSAGE =
  "These nights can't be priced at the moment (no active season covers them). You can still send the request; the booking officer confirms the price when they approve it.";

/**
 * An added guest's nights as the pricing engine reads them: the explicit night
 * set from the editor's grid (#713, #4088) when it has one, else the two
 * bounds, else the whole stay — by the canonical range rule (`INV-SSOT`). The
 * route has already refused a range that rule rejects.
 */
function addedGuestRange(
  guest: ChangeRequestAddGuest,
  index: number,
  booking: { checkIn: Date; checkOut: Date },
): NormalizedBookingGuestStayRange {
  return normalizeGuestStayRange(
    {
      stayStart: guest.stayStart ?? null,
      stayEnd: guest.stayEnd ?? null,
      nights: guest.nights ?? null,
    },
    booking,
    index,
  );
}

interface EstimateBooking {
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
  guests: Array<{
    stayStart: Date;
    stayEnd: Date;
    ageTier: AgeTier;
    isMember: boolean;
    nights: Array<{ stayDate: Date }>;
  }>;
}

/** Count-only party entries for a run of nights: locked at zero, never priced. */
function countOnly(
  guest: { ageTier: AgeTier; isMember: boolean },
  nights: Date[],
): GuestInput {
  return {
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    rateMembershipTypeId: "count-only",
    nights,
    lockedNightPrices: nights.map((stayDate) => ({ stayDate, priceCents: 0 })),
  };
}

/**
 * A guest already on the booking, as a party member for the night count only:
 * every night they hold is a locked entry, so `calculateBookingPrice` never
 * looks a rate up for them (`lockedNightPrices` short-circuits the lookup).
 */
function countOnlyExistingGuest(guest: EstimateBooking["guests"][number]): GuestInput {
  const nights =
    guest.nights.length > 0
      ? guest.nights.map((night) => night.stayDate)
      : getStayNights(guest.stayStart, guest.stayEnd);
  return countOnly(guest, nights);
}

export async function estimateChangeRequestAddedGuests(
  booking: EstimateBooking,
  addGuests: ReadonlyArray<ChangeRequestAddGuest>,
): Promise<ChangeRequestEstimate> {
  const checkIn = booking.checkIn;
  const checkOut = booking.checkOut;
  const nonMembers = addGuests
    .map((guest, index) => ({ guest, index }))
    .filter(({ guest }) => !guest.isMember);
  const addedGuestRanges = addGuests.map((guest, index) => addedGuestRange(guest, index, booking));
  const seasonYear = seasonYearOfStoredDate(checkIn);
  const lodgeId = booking.lodgeId ?? (await getDefaultLodgeId(prisma));
  const [seasons, groupDiscountSetting, subscriptionLockoutMode] = await Promise.all([
    loadActiveSeasonRates(prisma, lodgeId),
    prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    resolveSubscriptionLockoutMode(),
  ]);
  const groupDiscount = await resolveGroupDiscountRateType(
    prisma,
    toEditTimeGroupDiscountConfig(groupDiscountSetting),
  );
  // Non-members only, and with no member id, so the resolver reads no member.
  const rated = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear,
    subscriptionLockoutMode,
    guests: nonMembers.map(({ guest, index }) => {
      const range = addedGuestRanges[index] ?? { stayStart: checkIn, stayEnd: checkOut };
      return {
        ageTier: guest.ageTier as AgeTier,
        isMember: false,
        memberId: null,
        stayStart: range.stayStart,
        stayEnd: range.stayEnd,
        // A grid night set prices exactly those nights (`GuestInput.nights`).
        ...(range.nights ? { nights: range.nights } : {}),
      };
    }),
  });
  // The added guests in the order they were sent: a non-member's rated entry,
  // or a member's count-only one (#4030 review M5).
  const ratedByIndex = new Map(nonMembers.map(({ index }, row) => [index, rated[row]]));
  const addedEntries = addGuests.map((guest, index) => {
    const ratedEntry = ratedByIndex.get(index);
    if (ratedEntry) return ratedEntry;
    const range = addedGuestRanges[index] ?? { stayStart: checkIn, stayEnd: checkOut };
    return countOnly(
      { ageTier: guest.ageTier as AgeTier, isMember: true },
      range.nights ?? getStayNights(range.stayStart, range.stayEnd),
    );
  });
  let priced;
  try {
    priced = calculateBookingPrice(
      checkIn,
      checkOut,
      [...booking.guests.map(countOnlyExistingGuest), ...addedEntries],
      seasons,
      groupDiscount,
    );
  } catch {
    // The engine's only throw here is a night no active season prices.
    return { outcome: "unpriced", message: CHANGE_REQUEST_ESTIMATE_NO_RATE_MESSAGE };
  }
  const addedRows = priced.guests.slice(booking.guests.length);
  const guests = addGuests.map((_guest, index) => {
    const row = addedRows[index];
    return {
      priceCents: ratedByIndex.has(index) && row ? row.priceCents : null,
      nights: row?.nights ?? 0,
    };
  });
  return {
    outcome: "priced",
    guests,
    // Members' count-only rows are zero, so they add nothing here.
    totalCents: addedRows.reduce((sum, row) => sum + row.priceCents, 0),
    excludesMemberGuests: nonMembers.length < addGuests.length,
  };
}
