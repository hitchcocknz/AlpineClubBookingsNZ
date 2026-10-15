import { formatStayDate, type ClubDateFormat } from "@/lib/club-time";
import type { RequestedGuestNights as RequestedGuestNightsRow } from "@/lib/booking-change-request-stored";

/** "3 Jul 2026 – 4 Jul 2026, 6 Jul 2026", in the club's own date format. */
function describeRuns(runs: RequestedGuestNightsRow["runs"], format: ClubDateFormat): string {
  if (runs.length === 0) return "the whole stay";
  return runs
    .map(({ firstNight, lastNight }) =>
      firstNight === lastNight
        ? formatStayDate(firstNight, format)
        : `${formatStayDate(firstNight, format)} – ${formatStayDate(lastNight, format)}`,
    )
    .join(", ");
}

/**
 * #4088: each guest's nights as the request asks for them, so the officer sees
 * a grid request's gaps before approving applies them. Nights are listed as
 * runs of consecutive nights (first and last night, not the departure
 * morning); an existing guest whose nights the request repeats is marked.
 */
export function RequestedGuestNights({
  guests,
  format,
}: {
  guests: ReadonlyArray<RequestedGuestNightsRow> | undefined;
  format: ClubDateFormat;
}) {
  if (!guests || guests.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-muted-foreground" aria-label="Nights this request asks for">
      {guests.map((guest, index) => (
        <li key={`${guest.name}-${index}`}>
          {guest.name}
          {guest.added ? " (added)" : ""}: {describeRuns(guest.runs, format)}
          {guest.unchanged ? " (no change)" : ""}
        </li>
      ))}
    </ul>
  );
}
