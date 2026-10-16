import {
  normalizeGuestStayRanges,
  type NormalizedBookingGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import {
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type StayRangeDeltaEntry,
} from "@/lib/booking-modification-stay-ranges";

/**
 * Which nights each guest is priced on in the promo preview
 * (`POST /api/promo-codes/validate`), #4199.
 *
 * The preview prices a whole PARTY, not a delta: one row per guest, in the order
 * a guest-targeted code's indexes count them. On an edit (a booking id the
 * caller may read) that party is the edit the booking editor will save, so its
 * nights must be the ones the save prices. The save resolves them with the
 * modification planner, `resolveModificationStayRanges` (`INV-EXCEPT-022`), so
 * this module hands the party to that same planner as the delta it is, rather
 * than re-deciding any of its rules:
 *
 *  - a guest naming a row of this booking (`bookingGuestId`) whose member is the
 *    guest's member (both empty for a non-member) is a REMAINING guest, and
 *    their dates or night set are that guest's `guestStayRanges` entry. Only
 *    the first guest naming a row claims it;
 *  - every other guest is an ADDED guest;
 *  - the request's dates are the delta's dates.
 *
 * So a guest the grid gives the 10th and 12th is priced on two nights, as the
 * quote and the save price them; a range-mode guest's dates are continuous, as
 * the owner decided on #4189; and a request carrying no ranges at all keeps
 * each guest's stored nights unless the booking's dates moved, which is the
 * planner's own rule.
 *
 * A create preview (no booking) has no planner: each guest is normalised on
 * their own, exactly as the create route does. Range errors surface as
 * `BookingGuestStayRangeValidationError` for the route to answer with a 400.
 */
export type PromoPreviewStayGuest = StayRangeDeltaEntry & {
  memberId?: string | null;
  bookingGuestId?: string;
};

/** A row of the booking being edited, as much of it as stay resolution needs. */
export type PromoPreviewStoredGuest = LiveGuestStayRow & { memberId: string | null };

export function resolvePromoPreviewStays<Guest extends PromoPreviewStayGuest>(args: {
  checkIn: Date;
  checkOut: Date;
  guests: ReadonlyArray<Guest>;
  /** The booking an edit preview is for, with its rows the request names. */
  edit: {
    booking: { checkIn: Date; checkOut: Date };
    storedGuests: ReadonlyArray<PromoPreviewStoredGuest>;
  } | null;
}): {
  checkIn: Date;
  checkOut: Date;
  guests: Array<Guest & NormalizedBookingGuestStayRange>;
} {
  if (!args.edit) {
    return {
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guests: normalizeGuestStayRanges([...args.guests], {
        checkIn: args.checkIn,
        checkOut: args.checkOut,
      }),
    };
  }

  const storedById = new Map(args.edit.storedGuests.map((row) => [row.id, row]));
  const remainingRows: PromoPreviewStoredGuest[] = [];
  const partyIndexByRowId = new Map<string, number>();
  const addedPartyIndexes: number[] = [];
  args.guests.forEach((guest, index) => {
    const row = guest.bookingGuestId ? storedById.get(guest.bookingGuestId) : undefined;
    const sameMember = row && (row.memberId ?? null) === (guest.memberId?.trim() || null);
    if (row && sameMember && !partyIndexByRowId.has(row.id)) {
      remainingRows.push(row);
      partyIndexByRowId.set(row.id, index);
    } else {
      addedPartyIndexes.push(index);
    }
  });

  const stayOf = (guest: Guest): StayRangeDeltaEntry => ({
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    nights: guest.nights,
  });
  const guestAt = (index: number): Guest => {
    const guest = args.guests[index];
    if (guest === undefined) {
      throw new Error(`Promo preview has no guest at party position ${index} (#4199).`);
    }
    return guest;
  };

  const resolved = resolveModificationStayRanges({
    booking: args.edit.booking,
    guests: remainingRows,
    input: {
      checkIn: args.checkIn,
      checkOut: args.checkOut,
      guestStayRanges: remainingRows.map((row) => ({
        guestId: row.id,
        ...stayOf(guestAt(partyIndexByRowId.get(row.id)!)),
      })),
      addGuests: addedPartyIndexes.map((index) => stayOf(guestAt(index))),
    },
  });

  const rangeByPartyIndex = new Map<number, NormalizedBookingGuestStayRange>();
  for (const { guest: row, ...range } of resolved.remaining) {
    rangeByPartyIndex.set(partyIndexByRowId.get(row.id)!, range);
  }
  resolved.added.forEach((range, addedIndex) => {
    rangeByPartyIndex.set(addedPartyIndexes[addedIndex]!, range);
  });

  return {
    checkIn: resolved.checkIn,
    checkOut: resolved.checkOut,
    guests: args.guests.map((guest, index) => {
      const range = rangeByPartyIndex.get(index);
      if (range === undefined) {
        throw new Error(`Promo preview resolved no stay for party position ${index} (#4199).`);
      }
      // The planner's answer replaces the request's own fields outright, so a
      // night set the planner did not keep cannot ride along as strings.
      return { ...guest, stayStart: range.stayStart, stayEnd: range.stayEnd, nights: range.nights };
    }),
  };
}
