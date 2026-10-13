// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));
// Single-lodge club: the scope select renders nothing, so the club-wide list.
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

import { expectToHoldFocus } from "@/lib/__tests__/helpers/focus";
import { BookingPeriodsSection } from "../booking-periods-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";

// #4116: a row's Activate/Deactivate and Delete are direct writes. The minimum
// stay list refreshes through its loading state, unmounting the pressed button;
// a booking period's Delete removes its row, and a toggle is disabled for the
// round trip, which a browser answers by dropping focus to the page. Each
// returns focus to a control in the list, or to the card, through
// `useRowActionFocusReturn`.

const POLICY = {
  id: "m1",
  name: "Winter Saturdays",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  triggerDays: [6],
  minimumNights: 2,
  capacityMode: "HOLD",
  version: 4,
  active: true,
};

function period(id: string, name: string) {
  return {
    id,
    name,
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-14T00:00:00.000Z",
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [
      {
        daysBeforeStay: 21,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ],
    active: true,
  };
}

/**
 * GETs answer `before` until a write has landed and `after` from then on; the
 * refresh after the write is held until `release()`, so a test can see the
 * pressed button gone before the list comes back.
 */
function stubWrite(before: unknown[], after: unknown[], written: unknown) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let wrote = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        wrote = true;
        return new Response(JSON.stringify(written), { status: 200 });
      }
      if (wrote) await held;
      return new Response(JSON.stringify(wrote ? after : before), {
        status: 200,
      });
    }),
  );
  return { release: () => release(), wrote: () => wrote };
}

/** Let the write's own response, and everything it schedules, finish first. */
async function settleAfter(wrote: () => boolean) {
  await waitFor(() => expect(wrote()).toBe(true));
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Operate a control the way a keyboard user does: it holds focus first. */
function press(control: HTMLElement) {
  control.focus();
  fireEvent.click(control);
}

const buttons = (name: string) => screen.getAllByRole("button", { name });

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MinimumNightStaySection returns focus after a row write (#4116)", () => {
  it("returns to the row's re-rendered toggle after Deactivate", async () => {
    const inactive = { ...POLICY, active: false, version: 5 };
    const { release } = stubWrite([POLICY], [inactive], inactive);
    render(<MinimumNightStaySection />);
    const deactivate = await screen.findByRole("button", { name: "Deactivate" });
    press(deactivate);

    await screen.findByText("Loading...");
    expect(deactivate.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
    release();

    await expectToHoldFocus(
      await screen.findByRole("button", { name: "Activate" }),
    );
  });

  it("returns to the row's toggle after Delete, which leaves the row inactive", async () => {
    const deleted = { ...POLICY, active: false, version: 5 };
    const { release } = stubWrite([POLICY], [deleted], { policy: deleted });
    render(<MinimumNightStaySection />);
    const del = await screen.findByRole("button", { name: "Delete" });
    press(del);

    await screen.findByText("Loading...");
    expect(del.isConnected).toBe(false);
    release();

    await screen.findByText(
      "Minimum stay policy deleted — it is listed as inactive",
    );
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    await expectToHoldFocus(
      await screen.findByRole("button", { name: "Activate" }),
    );
  });

  it("falls back to the card when the row is gone after the refresh", async () => {
    const { release } = stubWrite([POLICY], [], { policy: null });
    render(<MinimumNightStaySection />);
    press(await screen.findByRole("button", { name: "Delete" }));

    await screen.findByText("Loading...");
    release();

    await expectToHoldFocus(
      await screen.findByRole("region", { name: "Minimum Night Stay" }),
    );
  });
});

describe("BookingPeriodsSection returns focus after a row write (#4116)", () => {
  const A = period("p1", "Term One");
  const B = period("p2", "Term Two");
  const C = period("p3", "Term Three");

  it("returns to the toggle a browser dropped focus from while it was disabled", async () => {
    const { release } = stubWrite([A], [{ ...A, active: false }], {});
    render(<BookingPeriodsSection />);
    const deactivate = await screen.findByRole("button", { name: "Deactivate" });
    press(deactivate);

    // jsdom keeps focus on a disabled button (and will not blur one); a
    // browser's focus fixup drops it to the page. Model that by parking focus
    // on a throwaway control and removing it.
    await waitFor(() =>
      expect((deactivate as HTMLButtonElement).disabled).toBe(true),
    );
    const parked = document.body.appendChild(document.createElement("button"));
    parked.focus();
    parked.remove();
    expect(document.activeElement).toBe(document.body);
    release();

    await expectToHoldFocus(
      await screen.findByRole("button", { name: "Activate" }),
    );
  });

  it("returns to the next row's Delete after a Delete", async () => {
    const { release, wrote } = stubWrite([A, B, C], [A, C], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    const del = buttons("Delete")[1];
    press(del);
    // The refresh lands well after the delete: a return that did not wait for
    // it would fire while the deleted row was still on screen.
    await settleAfter(wrote);
    release();

    await waitFor(() => expect(screen.queryByText("Term Two")).toBeNull());
    expect(del.isConnected).toBe(false);
    await expectToHoldFocus(buttons("Delete")[1]);
  });

  it("returns to the previous row's Delete after deleting the last row", async () => {
    const { release } = stubWrite([A, B], [A], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    press(buttons("Delete")[1]);
    release();

    await waitFor(() => expect(screen.queryByText("Term Two")).toBeNull());
    await expectToHoldFocus(buttons("Delete")[0]);
  });

  it("falls back to the card when the last period is deleted", async () => {
    const { release } = stubWrite([A], [], {});
    render(<BookingPeriodsSection />);
    press(await screen.findByRole("button", { name: "Delete" }));
    release();

    await screen.findByText(/No date-specific periods configured/);
    await expectToHoldFocus(
      screen.getByRole("region", { name: "Date-Specific Periods" }),
    );
  });

  it("leaves the open editor's own return intact after a row write", async () => {
    // The row write keeps its own anchor: consuming the editor's would leave a
    // later Cancel with nowhere to return to.
    const { release } = stubWrite([A, B], [A, { ...B, active: false }], {});
    render(<BookingPeriodsSection />);
    await screen.findByText("Term Two");
    press(buttons("Edit")[0]);
    press(buttons("Deactivate")[1]);
    release();
    await expectToHoldFocus(await screen.findByRole("button", { name: "Activate" }));

    press(screen.getByRole("button", { name: "Cancel" }));
    await expectToHoldFocus(buttons("Edit")[0]);
  });
});
