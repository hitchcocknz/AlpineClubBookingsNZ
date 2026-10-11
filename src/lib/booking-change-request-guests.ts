import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { parseCalendarDate } from "@/lib/club-time";
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
 * a run of nights inside the stay. An absent bound is the stay's own bound,
 * which is how the request has always read a guest with no range.
 *
 * Calendar days compare correctly as strings once each has parsed as one, so
 * no instant is built here (`INV-DATE`).
 */
export function addedGuestNightsRefusal(
  guests: ReadonlyArray<Pick<ChangeRequestAddGuest, "firstName" | "lastName" | "stayStart" | "stayEnd">>,
  stay: ChangeRequestStay,
): string | null {
  for (const guest of guests) {
    const start = guest.stayStart ?? stay.checkIn;
    const end = guest.stayEnd ?? stay.checkOut;
    const name = `${guest.firstName} ${guest.lastName}`.trim();
    if (!parseCalendarDate(start) || !parseCalendarDate(end)) {
      return `${name}'s dates are not valid dates.`;
    }
    if (start >= end) {
      return `${name}'s date out must be after their date in.`;
    }
    if (start < stay.checkIn || end > stay.checkOut) {
      return `${name}'s nights must fall within the stay (${stay.checkIn} to ${stay.checkOut}).`;
    }
  }
  return null;
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
