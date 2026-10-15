import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { addCalendarDays, calendarDateOfDateOnlyInstant, countClubNights, parseCalendarDate } from "@/lib/club-time";
import type { BatchModifyInput } from "@/lib/booking-modify";
import {
  guestNightKeys,
  isEffectiveStayRangeChange,
  nightsKeptByRepeatedRange,
  storedGuestNightsAsDays,
  type GuestNightsAsDays,
} from "@/lib/booking-change-request-guests";
import { guestName } from "@/lib/bed-allocation-display-names";
import { collapseNightRuns } from "@/lib/bed-allocation-board-window";
import { guestNightListSchema } from "@/lib/booking-guest-stay-range-input";

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
 * A guest's explicit night set (#713) as stored (#4088), read by the request's
 * own schema so a malformed night makes the row unreadable rather than throwing
 * later. Absent on rows written before grid-mode requests kept their nights.
 */
const optionalNights = guestNightListSchema.nullish();

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
    // #4088: and the guest's night rows, so a grid night set repeating them is
    // not a change, and approval sees a night trimmed since as drift.
    guests: z.array(
      z.object({
        id: z.string(),
        stayStart: z.string().nullish(),
        stayEnd: z.string().nullish(),
        nights: optionalNights,
        // Shown to the officer beside the nights asked for (#4088).
        firstName: z.string().nullish(),
        lastName: z.string().nullish(),
      }),
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
          nights: optionalNights,
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
          nights: optionalNights,
        }),
      )
      .default([]),
  }),
});

export type StoredLockedPeriodRequest = z.infer<typeof storedLockedPeriodRequestSchema>;

/**
 * A booking guest's live range and night rows, as the executor reads them
 * under its locks and the admin list reads them for the officer's card.
 */
export interface LiveRequestGuestRow {
  id: string;
  stayStart: Date;
  stayEnd: Date;
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}

/**
 * The nights a repeated range is judged against (#4157, `INV-REQ-012`): the
 * guest's live rows when the caller read them, else the request's own snapshot
 * of the guest. One source for approval and for the officer's card, so the
 * card never shows nights the approval would not keep.
 */
function keptNightsSource(
  guestId: string,
  liveGuests: ReadonlyArray<LiveRequestGuestRow> | undefined,
  snapshot: GuestNightsAsDays | undefined,
): GuestNightsAsDays | undefined {
  const live = liveGuests?.find((guest) => guest.id === guestId);
  return live ? storedGuestNightsAsDays(live) : snapshot;
}

/**
 * The canonical batch input a stored request asks for, or `null` when it asks
 * for nothing the booking can be changed by — a request that only named an
 * effective date, or whose dates equal the booking's own.
 *
 * The executor and `storedRequestNamesNoChange` are its callers. The executor
 * passes the booking's live guest rows, read under its locks, so a guest's
 * kept nights (#4157) are the ones they hold now; without them the request's
 * own snapshot of the guest's nights is read.
 */
export function lockedPeriodRequestToBatchInput(
  stored: StoredLockedPeriodRequest,
  booking: {
    checkIn: Date;
    checkOut: Date;
    guests?: ReadonlyArray<LiveRequestGuestRow>;
  },
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
  const currentRanges = new Map(
    stored.original.guests.flatMap((guest) =>
      guest.stayStart && guest.stayEnd
        ? [
            [
              guest.id,
              { stayStart: guest.stayStart, stayEnd: guest.stayEnd, nights: guest.nights },
            ] as const,
          ]
        : [],
    ),
  );
  // Every two-bound range for a guest who stays is passed through, unchanged
  // ones included (#4030 re-review of 72c933ffc): a stored range is how the
  // planner keeps a part-stay guest's own nights when the envelope moves. Drop
  // the unchanged ones and a request that only shortens the stay and removes a
  // guest leaves range mode, so every remaining guest is stretched to the new
  // envelope and charged for nights they never stayed.
  //
  // #4088: a grid-mode range is the guest's night set, passed through as the
  // planner's `nights` (#713) — the same writer the editor's grid uses — so
  // approval applies, and prices, exactly the nights the member chose.
  const requestedRanges = requested.guestStayRanges
    // Not `entryHasStayRange`: that admits a one-bound range, which a row stored
    // before #4030 refused them may still hold, and this has always dropped.
    .filter((range) => Boolean(range.stayStart && range.stayEnd) || Boolean(range.nights?.length))
    // A range for a guest the same request removes is moot, and the planner
    // would refuse it as naming a guest no longer on the booking.
    .filter((range) => !removed.has(range.guestId))
    .map((range) => ({
      guestId: range.guestId,
      stayStart: range.stayStart ?? null,
      stayEnd: range.stayEnd ?? null,
      ...(range.nights?.length ? { nights: range.nights } : {}),
    }));
  const addGuests = requested.addGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
    ...(guest.nights?.length ? { nights: guest.nights } : {}),
  }));
  // #4030 review M2: whether the request names nothing is judged on the ranges
  // that CHANGE something — a range repeating the guest's stored nights is not
  // a change. This test decides only that; it never filters what is applied.
  // It reads the ranges as the member sent them, before #4157 below.
  const namesRangeChange = requestedRanges.some((range) =>
    isEffectiveStayRangeChange(range, currentRanges.get(range.guestId)),
  );
  // #4157 (owner decision "Keep their nights"): a two-bound range that only
  // repeats a gapped guest's own Date In and Date Out is applied as the nights
  // they hold, so approval neither fills nor charges their gaps. It stays in
  // the list, as an explicit night set, for the reason above: range mode must
  // not switch off. A range that moves a bound is applied as written.
  const guestStayRanges = requestedRanges.map((range) => {
    const kept = nightsKeptByRepeatedRange(
      range,
      keptNightsSource(range.guestId, booking.guests, currentRanges.get(range.guestId)),
    );
    return kept ? { ...range, nights: kept } : range;
  });
  if (
    !checkIn &&
    !checkOut &&
    addGuests.length === 0 &&
    removeGuestIds.length === 0 &&
    !namesRangeChange
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

/** One guest's nights as a request asks for them, for the officer's card (#4088). */
export interface RequestedGuestNights {
  name: string;
  /** Runs of consecutive nights, first and last night inclusive; empty for the whole stay. */
  runs: Array<{ firstNight: string; lastNight: string }>;
  /** How many nights the runs hold; `null` for the whole stay. */
  nightCount: number | null;
  /** The guest is one the request adds, not one already on the booking. */
  added: boolean;
  /** An existing guest whose requested nights are the ones they already hold. */
  unchanged: boolean;
  /**
   * An existing guest with gaps in their stay whose request MOVES their Date In
   * or Date Out (a range rather than a night set): approving writes every night
   * of that range, so the gaps inside it are filled (and charged). A range that
   * only repeats their own dates keeps their nights (#4157) and is `unchanged`.
   */
  fillsGaps: boolean;
}

type StoredNights = { stayStart?: string | null; stayEnd?: string | null; nights?: string[] | null };

/** A grid night set as runs; else the two bounds as one run, never expanded. */
function requestedRuns(
  entry: StoredNights,
): Pick<RequestedGuestNights, "runs" | "nightCount"> | null {
  if (entry.nights?.length) {
    const runs = collapseNightRuns(entry.nights);
    return {
      runs: runs.map(({ firstNight, lastNight }) => ({ firstNight, lastNight })),
      nightCount: runs.reduce((sum, run) => sum + run.nights.length, 0),
    };
  }
  const stayStart = entry.stayStart ? parseCalendarDate(entry.stayStart) : null;
  const stayEnd = entry.stayEnd ? parseCalendarDate(entry.stayEnd) : null;
  if (!stayStart || !stayEnd) return null;
  return {
    runs: [{ firstNight: stayStart, lastNight: addCalendarDays(stayEnd, -1) }],
    nightCount: countClubNights(stayStart, stayEnd),
  };
}

/**
 * Whether a two-bound range covers a night inside the guest's stored stay that
 * the guest does not hold. Walks only the STORED envelope, never the member's.
 * A range repeating the guest's own dates fills nothing: approval keeps the
 * nights they hold (#4157, `nightsKeptByRepeatedRange`).
 */
function rangeFillsGaps(range: StoredNights, current: GuestNightsAsDays | undefined): boolean {
  if (range.nights?.length || !range.stayStart || !range.stayEnd || !current?.nights?.length) return false;
  if (nightsKeptByRepeatedRange(range, current)) return false;
  const held = new Set(guestNightKeys(current));
  const { stayStart, stayEnd } = range;
  return guestNightKeys({ stayStart: current.stayStart, stayEnd: current.stayEnd }).some(
    (night) => !held.has(night) && night >= stayStart && night < stayEnd,
  );
}

/**
 * Each guest's requested nights, read from the stored request by the
 * executor's own schema, so the officer's card shows the nights approving
 * would apply (#4088): a grid night set as chosen, the nights a guest
 * already holds where their range only repeats their own dates (#4157), else
 * Date In to the last night. Guests the request does not name are not listed;
 * an unreadable row lists nobody.
 *
 * `context.status` is the request's own. Only a pending (`REQUESTED`) request
 * is read as approval will apply it, against `context.guests` — the booking's
 * live guest rows, the source approval reads (`keptNightsSource`). A decided
 * request is described as it was sent, against its snapshot: one approved
 * before #4157 filled a repeated range's gaps and one approved since kept
 * them, and the row does not say which, so a repeated range on a gapped guest
 * is listed as asked and marked neither "no change" nor "fills the gaps".
 */
export function describeRequestedGuestNights(
  requestedChanges: unknown,
  context: { status: string; guests?: ReadonlyArray<LiveRequestGuestRow> },
): RequestedGuestNights[] {
  const parsed = storedLockedPeriodRequestSchema.safeParse(requestedChanges);
  if (!parsed.success) return [];
  const { original, requested } = parsed.data;
  const pending = context.status === "REQUESTED";
  const removed = new Set(requested.removeGuests.map((guest) => guest.id));
  const existing = requested.guestStayRanges.flatMap((range) => {
    if (removed.has(range.guestId)) return [];
    const guest = original.guests.find((candidate) => candidate.id === range.guestId);
    const snapshot =
      guest?.stayStart && guest.stayEnd
        ? { stayStart: guest.stayStart, stayEnd: guest.stayEnd, nights: guest.nights }
        : undefined;
    const current = pending ? keptNightsSource(range.guestId, context.guests, snapshot) : snapshot;
    // Non-null exactly where the outcome depends on #4157's rule.
    const repeatsGapped = nightsKeptByRepeatedRange(range, current);
    const kept = pending ? repeatsGapped : null;
    const nights = requestedRuns(kept ? { nights: kept } : range);
    if (!nights) return [];
    const fillsGaps = rangeFillsGaps(range, current);
    const unchanged =
      Boolean(current) &&
      !fillsGaps &&
      !(repeatsGapped && !pending) &&
      !isEffectiveStayRangeChange(range, current);
    const name = (guest && guestName(guest)) || "A guest on the booking";
    return [{ name, ...nights, added: false, unchanged, fillsGaps }];
  });
  const added = requested.addGuests.map((guest) => ({
    name: guestName(guest),
    ...(requestedRuns(guest) ?? { runs: [], nightCount: null }),
    added: true,
    unchanged: false,
    fillsGaps: false,
  }));
  return [...existing, ...added];
}
