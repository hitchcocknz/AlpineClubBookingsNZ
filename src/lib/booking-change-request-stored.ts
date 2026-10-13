import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import type { BatchModifyInput } from "@/lib/booking-modify";
import { isEffectiveStayRangeChange } from "@/lib/booking-change-request-guests";

/**
 * A LOCKED_PERIOD change request's stored `requestedChanges`, read back, and
 * what it asks the booking to become (#3750). Moved out of
 * `booking-change-request-execution.ts` (#4030) so the admin list can ask
 * "does this request name a change?" through the executor's own mapping
 * without loading the batch modification service.
 */

// ---------------------------------------------------------------------------
// The stored request
// ---------------------------------------------------------------------------

const optionalDate = z.string().nullish();

/**
 * What `POST /api/bookings/[id]/change-requests` writes into
 * `requestedChanges`, read back defensively: the column is JSON and older rows
 * predate some fields, so anything this cannot parse is refused as unreadable
 * rather than half-executed.
 */
export const storedLockedPeriodRequestSchema = z.object({
  original: z.object({
    checkIn: z.string(),
    checkOut: z.string(),
    // The guest's stored range is read when present (#4030 review M2), so a
    // range repeating it is not mistaken for a change.
    guests: z.array(
      z.object({ id: z.string(), stayStart: z.string().nullish(), stayEnd: z.string().nullish() }),
    ),
  }),
  requested: z.object({
    checkIn: optionalDate,
    checkOut: optionalDate,
    addGuests: z
      .array(
        z.object({
          firstName: z.string(),
          lastName: z.string(),
          ageTier: bookableAgeTierEnum,
          isMember: z.boolean(),
          memberId: z.string().nullish(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
        }),
      )
      .default([]),
    removeGuests: z.array(z.object({ id: z.string() })).default([]),
    guestStayRanges: z
      .array(
        z.object({
          guestId: z.string(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
        }),
      )
      .default([]),
  }),
});

export type StoredLockedPeriodRequest = z.infer<typeof storedLockedPeriodRequestSchema>;

/**
 * The canonical batch input a stored request asks for, or `null` when it asks
 * for nothing the booking can be changed by — a request that only named an
 * effective date, or whose dates equal the booking's own.
 *
 * The executor and `storedRequestNamesNoChange` are its callers.
 */
export function lockedPeriodRequestToBatchInput(
  stored: StoredLockedPeriodRequest,
  booking: { checkIn: Date; checkOut: Date },
): Pick<
  BatchModifyInput,
  "checkIn" | "checkOut" | "addGuests" | "removeGuestIds" | "guestStayRanges"
> | null {
  const currentCheckIn = calendarDateOfDateOnlyInstant(booking.checkIn);
  const currentCheckOut = calendarDateOfDateOnlyInstant(booking.checkOut);
  const { requested } = stored;
  const checkIn =
    requested.checkIn && requested.checkIn !== currentCheckIn
      ? requested.checkIn
      : undefined;
  const checkOut =
    requested.checkOut && requested.checkOut !== currentCheckOut
      ? requested.checkOut
      : undefined;
  const removeGuestIds = requested.removeGuests.map((guest) => guest.id);
  const removed = new Set(removeGuestIds);
  // A range for a guest the same request removes is moot, and the planner would
  // refuse it as naming a guest no longer on the booking.
  const currentRanges = new Map(
    stored.original.guests.flatMap((guest) =>
      guest.stayStart && guest.stayEnd
        ? [[guest.id, { stayStart: guest.stayStart, stayEnd: guest.stayEnd }] as const]
        : [],
    ),
  );
  const guestStayRanges = requested.guestStayRanges
    // #4030 review M2: only a range that changes something is a change.
    .filter((range) => isEffectiveStayRangeChange(range, currentRanges.get(range.guestId)))
    .filter((range) => !removed.has(range.guestId))
    .map((range) => ({
      guestId: range.guestId,
      stayStart: range.stayStart ?? null,
      stayEnd: range.stayEnd ?? null,
    }));
  const addGuests = requested.addGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
  }));
  if (
    !checkIn &&
    !checkOut &&
    addGuests.length === 0 &&
    removeGuestIds.length === 0 &&
    guestStayRanges.length === 0
  ) {
    return null;
  }
  return {
    ...(checkIn ? { checkIn } : {}),
    ...(checkOut ? { checkOut } : {}),
    ...(addGuests.length > 0 ? { addGuests } : {}),
    ...(removeGuestIds.length > 0 ? { removeGuestIds } : {}),
    ...(guestStayRanges.length > 0 ? { guestStayRanges } : {}),
  };
}

/**
 * #4030: whether a stored request names nothing the booking can be changed by —
 * the free-text requests the officer may enter guests for on approval. `false`
 * for an unreadable row (there is no telling what it asks), so the officer is
 * never offered an entry the executor would refuse as unreadable.
 *
 * Asked by the admin list (`acceptsOfficerGuests`) and by the executor, through
 * the one mapping (`lockedPeriodRequestToBatchInput`), so they cannot disagree.
 */
export function storedRequestNamesNoChange(
  requestedChanges: unknown,
  booking: { checkIn: Date; checkOut: Date },
): boolean {
  const stored = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  return stored.success && lockedPeriodRequestToBatchInput(stored.data, booking) === null;
}
