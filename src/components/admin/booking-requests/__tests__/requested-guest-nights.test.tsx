// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";

import { RequestedGuestNights } from "@/components/admin/booking-requests/requested-guest-nights";
import { formatStayDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

/**
 * #4088: the officer's card lists each guest's requested nights as runs, in the
 * club's date format, so a grid request's gaps are visible before approving.
 */
describe("RequestedGuestNights", () => {
  const day = (value: string) => formatStayDate(value, CLUB_FORMAT_TEST);

  it("lists runs, the whole stay for an added guest with no nights, and an unchanged guest", () => {
    render(
      <RequestedGuestNights
        format={CLUB_FORMAT_TEST}
        guests={[
          {
            name: "Jo Bloggs",
            runs: [
              { firstNight: "2026-07-03", lastNight: "2026-07-04" },
              { firstNight: "2026-07-06", lastNight: "2026-07-06" },
            ],
            added: false,
            unchanged: false,
          },
          { name: "Ari Example", runs: [], added: true, unchanged: false },
          {
            name: "Sam Example",
            runs: [{ firstNight: "2026-07-03", lastNight: "2026-07-06" }],
            added: false,
            unchanged: true,
          },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      `Jo Bloggs: ${day("2026-07-03")} – ${day("2026-07-04")}, ${day("2026-07-06")}`,
      "Ari Example (added): the whole stay",
      `Sam Example: ${day("2026-07-03")} – ${day("2026-07-06")} (no change)`,
    ]);
  });

  it("renders nothing for a request that names no guest's nights", () => {
    const { container } = render(<RequestedGuestNights format={CLUB_FORMAT_TEST} guests={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
