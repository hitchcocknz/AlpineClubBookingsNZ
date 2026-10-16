import { z } from "zod";

import {
  addedGuestNightsRefusal,
  changeRequestAddGuestsSchema,
  changeRequestGuestStayRangesSchema,
  guestStayRangesRefusal,
  isAppliedChangeRequestRange,
  requestedDatesIgnoredByNightsRefusal,
  type ChangeRequestAddGuest,
} from "@/lib/booking-change-request-guests";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import type { LiveGuestStayRow } from "@/lib/booking-modification-stay-ranges";
import { storedDateOnly } from "@/lib/stored-calendar-day";

/** The proposal both submission and its added-guest estimate validate (INV-REQ-011). */
export const changeRequestDeltaSchema = z.object({
  checkIn: z.string().optional(),
  checkOut: z.string().optional(),
  addGuests: changeRequestAddGuestsSchema.optional(),
  removeGuestIds: z.array(z.string().trim().min(1)).max(200).optional(),
  guestStayRanges: changeRequestGuestStayRangesSchema.optional(),
  requestedEffectiveDate: z.string().optional(),
});

/** Preserve editor-first ordering at both quote and submission (INV-SSOT-001). */
export function mergeChangeRequestGuests(
  editorChanges: Record<string, unknown>,
  cardGuests: readonly ChangeRequestAddGuest[],
): Record<string, unknown> {
  if (cardGuests.length === 0) return editorChanges;
  return {
    ...editorChanges,
    addGuests: [...((editorChanges.addGuests as readonly ChangeRequestAddGuest[] | undefined) ?? []), ...cardGuests],
  };
}

function normalizeOptionalDateOnly(value: string | undefined) {
  if (!value) return null;
  const parsed = parseDateOnly(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Submission's date and night checks, in their original order, shared with quote. */
export function validateChangeRequestDatesAndNights(
  booking: { checkIn: Date; checkOut: Date; guests: ReadonlyArray<LiveGuestStayRow & { firstName: string; lastName: string }> },
  input: z.infer<typeof changeRequestDeltaSchema>,
) {
  const { checkIn, checkOut, addGuests, removeGuestIds, guestStayRanges: sentGuestStayRanges, requestedEffectiveDate } = input;
  const requestedCheckIn = normalizeOptionalDateOnly(checkIn);
  const requestedCheckOut = normalizeOptionalDateOnly(checkOut);
  const effectiveDate = normalizeOptionalDateOnly(requestedEffectiveDate);
  if ((checkIn && !requestedCheckIn) || (checkOut && !requestedCheckOut) || (requestedEffectiveDate && !effectiveDate)) {
    return { error: "Invalid booking date" };
  }

  const nextCheckIn = requestedCheckIn ?? storedDateOnly(booking.checkIn);
  const nextCheckOut = requestedCheckOut ?? storedDateOnly(booking.checkOut);
  if (nextCheckOut <= nextCheckIn) return { error: "Check-out must be after check-in" };

  const stay = { checkIn: formatDateOnly(nextCheckIn), checkOut: formatDateOnly(nextCheckOut) };
  const refusal =
    addedGuestNightsRefusal(addGuests ?? [], stay) ??
    guestStayRangesRefusal(sentGuestStayRanges ?? [], stay, booking.guests) ??
    requestedDatesIgnoredByNightsRefusal({
      booking,
      guests: booking.guests,
      input: {
        checkIn: requestedCheckIn,
        checkOut: requestedCheckOut,
        addGuests,
        removeGuestIds,
        guestStayRanges: sentGuestStayRanges?.filter(isAppliedChangeRequestRange),
      },
      movesCheckIn: Boolean(checkIn && checkIn !== calendarDateOfDateOnlyInstant(booking.checkIn)),
      movesCheckOut: Boolean(checkOut && checkOut !== calendarDateOfDateOnlyInstant(booking.checkOut)),
    });
  if (refusal) return { error: refusal };
  return { requestedCheckIn, requestedCheckOut, effectiveDate, nextCheckIn, nextCheckOut };
}
