import type { MemberGuestConsentStatus, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-error";
import { bookingForPromoLookup } from "@/lib/promo-guest-codes";
import { resolveGuestMemberLinks } from "@/lib/booking-modify-plan";
import {
  assertOtherLodgeExists,
  requestCarriesOtherLodgeElection,
  resolveOtherLodgeRateElection,
  type OtherLodgeRateInput,
} from "@/lib/booking-other-lodge-rate";
import { resolveOtherLodgeRateEligibleGuestIds } from "@/lib/membership-type-policy";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import type { PromoPreviewEdit } from "@/lib/promo-preview-stay-ranges";

/**
 * The booking an edit's promo preview (`POST /api/promo-codes/validate` with a
 * `bookingId`) is for (#3492, #4199, #4202): the booking the quote
 * (`modify-quote`) and the save price, so the promo box prices it the way they
 * do.
 *
 * - `bookingId`, `ownerMemberId` and `lodgeId` are the booking's own. The quote
 *   judges the membership type and the promotion against the booking's OWNER
 *   (`null` for a school's booking, whose unassigned codes the engine then
 *   refuses), leaves the booking's own promotion slots out of the usage caps,
 *   and prices at the booking's lodge; the preview does the same, whoever is
 *   asking and whatever lodge or member the request names.
 * - Each row the request names is read for its stored consent, which the
 *   preview judges that guest by; its stay, which the modification planner
 *   keeps for a guest the edit sends no dates for; the price each night was sold
 *   at, which the pricing pass keeps for every night the guest still holds
 *   (#1036); and its other-lodge flag.
 * - The two officer re-rates the quote is sent — a #2337 placeholder-to-member
 *   link and the other-lodge election — are resolved by the SAME resolvers the
 *   quote and the save run (`resolveGuestMemberLinks`,
 *   `resolveOtherLodgeRateElection`), so the preview refuses what they refuse,
 *   with their words, and re-rates exactly the guests they re-rate: a linked
 *   guest prices as the member with their locks cleared, and a ticked or
 *   unticked guest takes the election's flag with their locks cleared.
 */
export type PromoPreviewEditContext = {
  bookingId: string;
  ownerMemberId: string | null;
  lodgeId: string;
  consentById: Map<string, { memberId: string | null; consentStatus: MemberGuestConsentStatus | null }>;
  edit: PromoPreviewEdit;
};

/** The edit fields a preview request may carry, as the quote is sent them. */
export type PromoPreviewEditRequest = OtherLodgeRateInput & {
  guests: ReadonlyArray<{ bookingGuestId?: string }>;
  linkGuestToMember?: Array<{ guestId: string; memberId: string }>;
};

/**
 * `null` both for a booking that does not exist and for one the caller may not
 * read (`bookingForPromoLookup`), so the route answers both with one 404. A
 * re-rate the quote would refuse comes back as `refusal`, with its status.
 */
export async function promoPreviewEditContext(params: {
  bookingId: string;
  actorMemberId: string;
  role: Role;
  request: PromoPreviewEditRequest;
}): Promise<PromoPreviewEditContext | { refusal: { message: string; status: number } } | null> {
  const booking = await bookingForPromoLookup({
    bookingId: params.bookingId,
    actorMemberId: params.actorMemberId,
    isBookingOfficer: params.role === "ADMIN",
  });
  if (!booking) return null;
  let rerates: Rerates;
  try {
    rerates = await resolveRerates(booking, params.role, params.request);
  } catch (error) {
    if (error instanceof ApiError) return { refusal: { message: error.message, status: error.status } };
    throw error;
  }
  const bookingGuestIds = params.request.guests.flatMap((guest) => (guest.bookingGuestId ? [guest.bookingGuestId] : []));
  const rows = bookingGuestIds.length
    ? await prisma.bookingGuest.findMany({
        where: { bookingId: booking.id, id: { in: bookingGuestIds } },
        select: {
          id: true,
          memberId: true,
          consentStatus: true,
          otherLodgeMember: true,
          stayStart: true,
          stayEnd: true,
          nights: { select: { stayDate: true, priceCents: true, priceSource: true } },
        },
      })
    : [];
  return {
    bookingId: booking.id,
    ownerMemberId: booking.ownerMemberId,
    lodgeId: booking.lodgeId,
    consentById: new Map(rows.map((row) => [row.id, { memberId: row.memberId, consentStatus: row.consentStatus }])),
    edit: {
      booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
      storedGuests: rows.map(({ id, memberId, otherLodgeMember, stayStart, stayEnd, nights }) => ({
        id,
        memberId,
        stayStart,
        stayEnd,
        nights,
        otherLodgeMember: rerates.flaggedGuestIds ? rerates.flaggedGuestIds.has(id) : otherLodgeMember,
        repricedDeliberately: rerates.repriceGuestIds.has(id),
        linkedMemberId: rerates.linkedMemberByGuestId.get(id),
      })),
    },
  };
}

type Rerates = {
  /** The election's end state, or null when the request carries none (stored flags stand). */
  flaggedGuestIds: ReadonlySet<string> | null;
  /** Every guest whose locks the quote clears: linked, ticked or unticked. */
  repriceGuestIds: ReadonlySet<string>;
  linkedMemberByGuestId: ReadonlyMap<string, string>;
};

/**
 * The quote's own resolution of the two re-rates, over the whole stored party
 * (both resolvers judge every guest on the booking, not just the ones named).
 * Nothing is read when the request carries neither, which is every member's
 * preview.
 */
async function resolveRerates(
  booking: { id: string; checkIn: Date },
  role: Role,
  request: PromoPreviewEditRequest,
): Promise<Rerates> {
  const carriesElection = requestCarriesOtherLodgeElection(request);
  if (!request.linkGuestToMember?.length && !carriesElection) {
    return { flaggedGuestIds: null, repriceGuestIds: new Set(), linkedMemberByGuestId: new Map() };
  }
  const stored = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: { wholeLodgeHold: true, otherLodgeId: true, guests: true },
  });
  if (!stored) throw new ApiError("Booking not found", 404);
  const links = resolveGuestMemberLinks({
    booking: stored,
    input: { linkGuestToMember: request.linkGuestToMember },
    role,
  });
  const linkedMemberByGuestId = new Map(links.map((link) => [link.guestId, link.memberId]));
  // As the quote does: eligibility costs reads, so only for an officer's election.
  const eligibleGuestIds =
    role === "ADMIN" && carriesElection
      ? await resolveOtherLodgeRateEligibleGuestIds(prisma, {
          seasonYear: seasonYearOfStoredDate(booking.checkIn),
          guests: stored.guests,
        })
      : new Set<string>();
  const election = resolveOtherLodgeRateElection({
    booking: stored,
    input: { otherLodgeId: request.otherLodgeId, otherLodgeMemberGuestIds: request.otherLodgeMemberGuestIds },
    role,
    eligibleGuestIds,
    linkedGuestIds: new Set(linkedMemberByGuestId.keys()),
  });
  await assertOtherLodgeExists(prisma, election.otherLodgeId);
  return {
    flaggedGuestIds: carriesElection ? election.flaggedGuestIds : null,
    repriceGuestIds: new Set([...linkedMemberByGuestId.keys(), ...election.repriceGuestIds]),
    linkedMemberByGuestId,
  };
}
