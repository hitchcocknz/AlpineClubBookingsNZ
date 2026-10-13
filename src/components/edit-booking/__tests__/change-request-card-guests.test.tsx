// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChangeRequestCard } from "@/components/edit-booking/change-request-card";

/**
 * #4030 Part A: the in-progress "Admin Request" card names who the member is
 * asking to add — the guest editor's fields, nights inside the stay — shows the
 * estimate for them, and sends them as `addGuests`. A note alone cannot be sent.
 */

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const AGE_TIERS = [
  { tier: "CHILD" as const, label: "Child (5-9)", sortOrder: 1 },
  { tier: "ADULT" as const, label: "Adult (18+)", sortOrder: 3 },
];

function renderCard(overrides: Partial<Parameters<typeof ChangeRequestCard>[0]> = {}) {
  const onSubmit = vi.fn().mockResolvedValue(true);
  const props: Parameters<typeof ChangeRequestCard>[0] = {
    reason: "",
    submitting: false,
    error: "",
    success: "",
    hasEditorChanges: false,
    guestContext: {
      booking: {
        id: "bk-1",
        checkIn: "2026-06-30",
        checkOut: "2026-07-03",
        guests: [{ memberId: "m-1" }] as never,
        memberGuest: undefined,
        editPolicy: { mode: "in-progress", today: "2026-07-01", editableFrom: "2026-07-02", checkInEditable: false },
      },
      ageTierOptions: AGE_TIERS,
      familyMembers: [
        { id: "m-1", firstName: "Ada", lastName: "Owner", ageTier: "ADULT", relationship: "self" },
        { id: "m-2", firstName: "Kit", lastName: "Owner", ageTier: "CHILD", relationship: "dependent" },
      ],
    },
    onReasonChange: vi.fn(),
    onSubmit,
    ...overrides,
  };
  render(<ChangeRequestCard {...props} />);
  return { onSubmit };
}

function addNonMember(firstName: string, lastName: string) {
  fireEvent.change(screen.getByLabelText("First name"), { target: { value: firstName } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: lastName } });
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "CHILD" } });
  fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
}

describe("ChangeRequestCard — structured guests (#4030)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        estimate: {
          outcome: "priced",
          guests: [{ priceCents: 6000, nights: 3 }],
          totalCents: 6000,
          excludesMemberGuests: false,
        },
      }),
    );
  });

  it("will not send a note on its own, and says what to add", () => {
    renderCard({ reason: "Can we add three grandchildren" });
    expect(screen.getByRole("button", { name: "Request Admin Review" })).toBeDisabled();
    expect(screen.getByText(/A note on its own can.t be applied/)).toBeInTheDocument();
  });

  it("sends the guests entered, with their nights inside the stay", async () => {
    const { onSubmit } = renderCard();
    addNonMember("Ari", "Example");
    const dateIn = screen.getByLabelText("Date In");
    expect(dateIn).toHaveAttribute("min", "2026-06-30");
    // #4030 review S3: no later than the last locked night (today).
    expect(dateIn).toHaveAttribute("max", "2026-07-01");
    expect(screen.getByLabelText("Date Out")).toHaveAttribute("max", "2026-07-03");
    fireEvent.change(dateIn, { target: { value: "2026-07-01" } });

    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith([
      {
        firstName: "Ari",
        lastName: "Example",
        ageTier: "CHILD",
        isMember: false,
        stayStart: "2026-07-01",
        stayEnd: "2026-07-03",
      },
    ]);
    // Accepted: the list is cleared.
    await waitFor(() => expect(screen.queryByText(/Ari Example/)).not.toBeInTheDocument());
  });

  it("links a family member by member id, and never offers someone already on the booking", async () => {
    const { onSubmit } = renderCard();
    expect(screen.queryByRole("button", { name: "+ Ada Owner" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Kit Owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual([
      expect.objectContaining({ isMember: true, memberId: "m-2", ageTier: "CHILD" }),
    ]);
  });

  it("shows the estimate for exactly the guests on screen", async () => {
    renderCard();
    addNonMember("Ari", "Example");
    expect(await screen.findByText(/Estimated price for these guests: \$60\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Adding guests carries no change fee/)).toBeInTheDocument();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/bookings/bk-1/change-requests/quote");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      addGuests: [expect.objectContaining({ firstName: "Ari", stayStart: "2026-06-30", stayEnd: "2026-07-03" })],
    });
  });

  it("lets a request carrying the editor's own change through with no card guests", () => {
    renderCard({ hasEditorChanges: true });
    expect(screen.getByRole("button", { name: "Request Admin Review" })).toBeEnabled();
  });

  it("keeps the list when the request was refused", async () => {
    const { onSubmit } = renderCard();
    onSubmit.mockResolvedValue(false);
    addNonMember("Ari", "Example");
    fireEvent.click(screen.getByRole("button", { name: "Request Admin Review" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getByText(/Ari Example/)).toBeInTheDocument();
  });

  it("says members are priced on approval, rather than $0.00, when nobody listed is priced (review M5)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        estimate: { outcome: "priced", guests: [{ priceCents: null, nights: 3 }], totalCents: 0, excludesMemberGuests: true },
      }),
    );
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "+ Kit Owner" }));
    expect(
      await screen.findByText("Members are priced at their membership rate when the officer approves."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).toBeNull();
  });

  it("offers the guest entry only on a stay under way, and words a future stay's request plainly (review S4)", () => {
    render(
      <ChangeRequestCard
        reason=""
        submitting={false}
        error=""
        success=""
        hasEditorChanges
        guestContext={{
          booking: {
            id: "bk-1",
            checkIn: "2026-08-10",
            checkOut: "2026-08-12",
            guests: [] as never,
            memberGuest: undefined,
            editPolicy: { mode: "future", today: "2026-07-01", editableFrom: "2026-08-10", checkInEditable: true },
          },
          ageTierOptions: AGE_TIERS,
          familyMembers: [],
        }}
        onReasonChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("First name")).toBeNull();
    expect(screen.queryByText(/tonight or earlier/)).toBeNull();
    expect(screen.getByText(/needs the booking officer.s approval/)).toBeInTheDocument();
  });

  it("groups the added rows and the family buttons for assistive tech (review S5)", () => {
    renderCard();
    expect(screen.getByRole("group", { name: "Add a family member" })).toBeInTheDocument();
    addNonMember("Ari", "Example");
    expect(screen.getByRole("group", { name: "Guests to add" })).toBeInTheDocument();
  });
});
