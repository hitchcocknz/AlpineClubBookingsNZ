import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
  requireCalendarDate,
} from "@/lib/club-time";
import {
  BookingGuestStayRangeValidationError,
  normalizeGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import {
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type StayRangeDeltaInput,
} from "@/lib/booking-modification-stay-ranges";
import { nameField } from "@/lib/zod-helpers";

/**
 * The guests a LOCKED_PERIOD change request adds (#4030), in the one shape every
 * writer of one uses: the member's request (`POST /api/bookings/[id]/change-requests`),
 * its price estimate, and the officer entering them on the member's behalf on a
 * finished stay's approval (`PATCH /api/admin/booking-change-requests/[id]`).
 *
 * WHY #4030 EXISTS. A member whose stay was under way could only send a free-text
 * note ("can we add these three grandchildren"), which named nobody, so the
 * finished-stay approval (#3750) had nothing to charge. A request now has to
 * carry at least one structured change, and both ends of the queue can say who
 * is being added, with the same fields and nights inside the stay.
 */

/** One added guest, as the request carries it. Nights are `[stayStart, stayEnd)`. */
export const changeRequestAddGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: bookableAgeTierEnum,
  isMember: z.boolean(),
  memberId: z.string().trim().min(1).optional(),
  stayStart: z.string().optional(),
  stayEnd: z.string().optional(),
});

export type ChangeRequestAddGuest = z.infer<typeof changeRequestAddGuestSchema>;

/** The list form, capped as the request route always capped it. */
export const changeRequestAddGuestsSchema = z.array(changeRequestAddGuestSchema).max(200);

/**
 * The officer's entry (#4030 Part B): at least one guest, every one with its
 * nights stated, because the officer is entering what the member described and a
 * silent "whole stay" default is a guess about nights nobody wrote down.
 */
export const officerEnteredGuestsSchema = z
  .array(
    changeRequestAddGuestSchema.extend({
      stayStart: z.string(),
      stayEnd: z.string(),
    }),
  )
  .min(1)
  .max(200);

export type OfficerEnteredGuest = z.infer<typeof officerEnteredGuestsSchema>[number];

/**
 * The refusal a request with no structured change gets. A note alone cannot be
 * applied to the booking, so it is no longer a request (owner decision on #4030:
 * "a structured delta is required"). Said in the member's terms, pointing at the
 * controls that make one.
 */
export const CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE =
  "Add the guests (or change the dates) you are asking for, then send the request. A note on its own can't be applied to your booking; use it to tell the booking officer anything else they should know.";

/**
 * #4030 review M4 (`INV-GUEST-019`): a typed-in guest whose name matches one of
 * the booking owner's own dependants is refused when the request is sent, by
 * the same `checkOwnDependantIdentityForParty` every booking door runs, rather
 * than reaching the officer as a request the approval would then refuse. Said
 * to the member, and to the officer entering guests for them.
 *
 * Each message answers both readings of the name (#4030 re-review of
 * 72c933ffc), because neither surface takes the "different person, same name"
 * declaration the booking wizard and editor do: if it is the dependant, the
 * member path; if it is somebody else who shares the name, this surface cannot
 * add them, so they come off it.
 */
export const CHANGE_REQUEST_DEPENDANT_TYPED_MESSAGE =
  "Someone you are adding has the same name as one of your dependants. If it is your dependant, add them with their own button above (your family), so they are booked as the member they are. If it is a different person who shares the name, this request can't add them: take them off it and contact the club about them.";
export const OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE =
  "A guest you entered has the same name as one of the member's dependants. If it is that dependant, add them with + Add a member (the member finder) instead, so they are booked as the member they are. If it is a different person who shares the name, this entry can't add them: leave them off it and say so in your explanation to the member. Nothing has been changed; the request is still pending.";

/**
 * The stay a request's added guests must fall inside. `checkIn` / `checkOut` are
 * calendar days (`yyyy-MM-dd`), the booking's own or, on a request that also
 * moves them, the proposed ones.
 */
export interface ChangeRequestStay {
  checkIn: string;
  checkOut: string;
}

/**
 * Why an added guest's nights cannot be requested, or `null` when every one is
 * a run of nights inside the stay.
 *
 * The range itself is read by the canonical `normalizeGuestStayRange`
 * (`INV-SSOT`) — the rule every booking door uses: no bounds is the whole stay,
 * one bound alone is refused, Date Out must follow Date In. This adds only the
 * request's own rule, that the nights fall inside the stay (#4030 review M3).
 */
export function addedGuestNightsRefusal(
  guests: ReadonlyArray<Pick<ChangeRequestAddGuest, "firstName" | "lastName" | "stayStart" | "stayEnd">>,
  stay: ChangeRequestStay,
): string | null {
  const bounds = {
    checkIn: dateOnlyInstantOf(requireCalendarDate(stay.checkIn)),
    checkOut: dateOnlyInstantOf(requireCalendarDate(stay.checkOut)),
  };
  for (const [index, guest] of guests.entries()) {
    let range;
    try {
      range = normalizeGuestStayRange(
        { stayStart: guest.stayStart ?? null, stayEnd: guest.stayEnd ?? null },
        bounds,
        index,
      );
    } catch (error) {
      if (error instanceof BookingGuestStayRangeValidationError) return error.message;
      throw error;
    }
    if (range.stayStart < bounds.checkIn || range.stayEnd > bounds.checkOut) {
      const name = `${guest.firstName} ${guest.lastName}`.trim();
      return `${name}'s nights must fall within the stay (${stay.checkIn} to ${stay.checkOut}).`;
    }
  }
  return null;
}

/**
 * #4030 re-review of 72c933ffc: an existing guest's requested nights are read
 * by the same canonical range rule the added guests' are
 * (`normalizeGuestStayRange`): real `yyyy-mm-dd` days, both bounds or neither,
 * Date Out after Date In. The refusal message, or `null`. A range may still
 * reach outside the stay: the planner widens the stay to cover it, as an edit
 * does (#713).
 */
export function guestStayRangesRefusal(
  ranges: ReadonlyArray<{ stayStart?: string | null; stayEnd?: string | null }>,
  stay: ChangeRequestStay,
): string | null {
  const bounds = {
    checkIn: dateOnlyInstantOf(requireCalendarDate(stay.checkIn)),
    checkOut: dateOnlyInstantOf(requireCalendarDate(stay.checkOut)),
  };
  for (const [index, range] of ranges.entries()) {
    try {
      normalizeGuestStayRange(
        { stayStart: range.stayStart ?? null, stayEnd: range.stayEnd ?? null },
        bounds,
        index,
      );
    } catch (error) {
      if (error instanceof BookingGuestStayRangeValidationError) return error.message;
      throw error;
    }
  }
  return null;
}

export const CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE =
  "The new check-in or check-out date doesn't match the nights your guests are staying. Set each guest's nights to the dates you want; the stay's dates follow from them.";

/**
 * #4030 round 7 (F2): a request that moves check-in or check-out while also
 * naming guests' nights. With nights named, the planner sets the stay's dates
 * from them (`resolveModificationStayRanges`, range mode) and ignores the
 * requested ones, so a moved date the nights do not reach would be dropped
 * without a word. Refused instead, with `null` when the dates are where the
 * nights put them, or the request moves no date.
 */
export function requestedDatesIgnoredByNightsRefusal(args: {
  booking: { checkIn: Date; checkOut: Date };
  guests: ReadonlyArray<LiveGuestStayRow>;
  input: StayRangeDeltaInput;
  /** Whether the request moves check-in / check-out at all. */
  movesCheckIn: boolean;
  movesCheckOut: boolean;
}): string | null {
  if (!args.movesCheckIn && !args.movesCheckOut) return null;
  let resolved;
  try {
    resolved = resolveModificationStayRanges(args);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) return error.message;
    throw error;
  }
  if (!resolved.hasRangeInputs) return null;
  const ignored =
    (args.movesCheckIn && resolved.checkIn.getTime() !== resolved.requestedCheckIn.getTime()) ||
    (args.movesCheckOut && resolved.checkOut.getTime() !== resolved.requestedCheckOut.getTime());
  return ignored ? CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE : null;
}

/**
 * Whether a requested guest stay range actually changes anything (#4030 review
 * M2): both bounds given, and different from the guest's own stored range. A
 * range missing a bound, or repeating the guest's current nights, is not a
 * structured change — it must not let a note through as one, nor stop the
 * officer entering guests for what is really a free-text request.
 *
 * `current` is the guest's stored range as calendar days, or `undefined` when
 * it is not known (a range for a guest the request does not describe), in which
 * case a two-bound range counts.
 */
export function isEffectiveStayRangeChange(
  range: { stayStart?: string | null; stayEnd?: string | null },
  current: { stayStart: string; stayEnd: string } | undefined,
): boolean {
  if (!range.stayStart || !range.stayEnd) return false;
  if (!current) return true;
  return range.stayStart !== current.stayStart || range.stayEnd !== current.stayEnd;
}

/**
 * #4030 review M2: whether any of a request's stay ranges changes a guest's
 * nights, against the guests' stored `@db.Date` ranges.
 */
export function namesStayRangeChange(
  ranges: ReadonlyArray<{ guestId: string; stayStart?: string | null; stayEnd?: string | null }>,
  guests: ReadonlyArray<{ id: string; stayStart: Date; stayEnd: Date }>,
): boolean {
  return ranges.some((range) => {
    const guest = guests.find((candidate) => candidate.id === range.guestId);
    return isEffectiveStayRangeChange(
      range,
      guest
        ? {
            stayStart: calendarDateOfDateOnlyInstant(guest.stayStart),
            stayEnd: calendarDateOfDateOnlyInstant(guest.stayEnd),
          }
        : undefined,
    );
  });
}

/**
 * The one-line summary a request is listed and emailed under. Moved here from
 * the member route (#4030) so the officer's entry on an existing request is
 * summarised by the same words a member's own request is.
 */
export function buildChangeRequestSummary({
  checkIn,
  checkOut,
  addGuests,
  removedGuests,
  guestStayRanges,
  requestedEffectiveDate,
}: {
  checkIn?: string | null;
  checkOut?: string | null;
  addGuests?: ReadonlyArray<{ firstName: string; lastName: string; ageTier: AgeTier; isMember: boolean }>;
  removedGuests: ReadonlyArray<{ firstName: string; lastName: string }>;
  guestStayRanges?: ReadonlyArray<unknown>;
  requestedEffectiveDate?: string | null;
}): string {
  const parts: string[] = [];
  if (checkIn) parts.push(`check-in to ${checkIn}`);
  if (checkOut) parts.push(`check-out to ${checkOut}`);
  if (addGuests?.length) {
    parts.push(
      `add ${addGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (removedGuests.length) {
    parts.push(
      `remove ${removedGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (guestStayRanges?.length) {
    parts.push(`update ${guestStayRanges.length} guest stay range${guestStayRanges.length === 1 ? "" : "s"}`);
  }
  if (requestedEffectiveDate) {
    parts.push(`effective ${requestedEffectiveDate}`);
  }
  return parts.length ? parts.join("; ") : "Locked-period booking change";
}

/**
 * Appended to the summary of a request whose guests the officer entered, so
 * the queue, the member's booking page and the audit trail all say whose list
 * it is.
 */
export const OFFICER_ENTERED_SUMMARY_SUFFIX = "(entered by a booking officer on the member's behalf)";

/**
 * The stamp written into `requestedChanges.requested.officerEntry` beside the
 * guests an officer entered (#4030 Part B). It names the officer and keeps the
 * member's own summary, because the request now says something the member did
 * not write and the record has to show both.
 */
export interface OfficerEntryStamp {
  onMemberBehalf: true;
  officerMemberId: string;
  enteredAt: string;
  memberSummary: string | null;
}

/**
 * The member's estimate for the guests a request adds (#4030 Part A), as
 * `estimateChangeRequestAddedGuests` answers and the request card reads it.
 */
export type ChangeRequestEstimate =
  | {
      outcome: "priced";
      /** One per added guest, in order; `null` for a member guest (not priced). */
      guests: Array<{ priceCents: number | null; nights: number }>;
      /** The non-member guests' total. */
      totalCents: number;
      /** True when a member guest is in the list and so not in the total. */
      excludesMemberGuests: boolean;
    }
  | { outcome: "unpriced"; message: string };

/**
 * The request's stored `requestedChanges` with an officer's entry written in
 * (#4030 Part B): the guests become the request's `addGuests`, the summary says
 * whose list it is, and `officerEntry` names the officer and keeps the member's
 * own summary. Everything else — `original`, the member's dates, the payment
 * snapshot, the locked-period facts — is kept exactly.
 *
 * Only ever called on a request that names no structured change (the executor
 * checks), so there is nothing of the member's own delta to merge with.
 */
export function withOfficerEnteredGuests(
  requestedChanges: unknown,
  guests: ReadonlyArray<OfficerEnteredGuest>,
  stamp: { officerMemberId: string; enteredAt: Date },
): Record<string, unknown> {
  const stored = isRecord(requestedChanges) ? requestedChanges : {};
  const requested = isRecord(stored.requested) ? stored.requested : {};
  const memberSummary = typeof requested.summary === "string" ? requested.summary : null;
  const officerEntry: OfficerEntryStamp = {
    onMemberBehalf: true,
    officerMemberId: stamp.officerMemberId,
    enteredAt: stamp.enteredAt.toISOString(),
    memberSummary,
  };
  return {
    ...stored,
    requested: {
      ...requested,
      addGuests: guests.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        ...(guest.isMember && guest.memberId ? { memberId: guest.memberId } : {}),
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
      })),
      summary: `${buildChangeRequestSummary({ addGuests: guests, removedGuests: [] })} ${OFFICER_ENTERED_SUMMARY_SUFFIX}`,
      officerEntry,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
