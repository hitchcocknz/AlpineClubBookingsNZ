// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #4030 Part B: a free-text request on a finished stay names nobody, so the
 * officer enters the guests the member described on the card. The figures are
 * worked out for exactly that list, and Approve and apply sends it.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function freeTextRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    version: 2,
    executesOnApproval: true,
    acceptsOfficerGuests: true,
    requestedChanges: { requested: { summary: "effective 2026-06-10", addGuests: [] } },
    reason: "Can we add these three grandchildren to our booking",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-06-10T10:00:00.000Z",
    requestedBy: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-06-10T00:00:00.000Z",
      checkOut: "2026-06-14T00:00:00.000Z",
      status: "COMPLETED",
      finalPriceCents: 12000,
      member: { id: "m-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      organisation: null,
      payment: null,
    },
    ...overrides,
  };
}

const QUOTE = {
  priceDiffCents: 8_000,
  changeFeeCents: 0,
  additionalAmountCents: 8_000,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
  capacityOverridden: false,
  settlementMethod: "card",
};

let rows: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = [freeTextRequest()];
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/quote")) return jsonResponse({ id: "req-1", quote: QUOTE });
    if (init?.method === "PATCH") {
      return jsonResponse({
        id: "req-1",
        execution: { executed: true, followUpFailed: false, officerEnteredGuestCount: 1 },
      });
    }
    if (url.includes("/api/admin/booking-change-requests")) {
      return jsonResponse({ data: rows, page: 1, pageSize: 25, total: rows.length, memberGuestFind: null });
    }
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function bodies(match: (url: string, init: RequestInit | undefined) => boolean) {
  return fetchMock.mock.calls
    .filter(([input, init]) => match(String(input), init as RequestInit | undefined))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}
const quoteBodies = () => bodies((url, init) => url.endsWith("/quote") && init?.method === "POST");
const patchBodies = () => bodies((url, init) => url.endsWith("req-1") && init?.method === "PATCH");

async function enterGuest(firstName: string) {
  fireEvent.change(await screen.findByLabelText("First name"), { target: { value: firstName } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Example" } });
  fireEvent.change(screen.getByLabelText("Age"), { target: { value: "CHILD" } });
  fireEvent.click(screen.getByRole("button", { name: "Add guest" }));
}

describe("change-request panel — the officer enters the guests (#4030)", () => {
  it("offers the entry only on a request that takes one", async () => {
    rows = [freeTextRequest({ acceptsOfficerGuests: false })];
    render(<BookingChangeRequestsPanel />);
    await screen.findByRole("button", { name: "Approve and apply" });
    expect(screen.queryByText(/Guests the member asked to add/)).toBeNull();
    expect(screen.queryByLabelText("First name")).toBeNull();
  });

  it("prices the entered guests and sends them with the approval", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText(/Guests the member asked to add/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Explanation for the member/i), {
      target: { value: "Added your grandchildren." },
    });
    await enterGuest("Ari");
    // Nights bounded to the stay.
    expect(screen.getByLabelText("Date In")).toHaveAttribute("min", "2026-06-10");
    expect(screen.getByLabelText("Date Out")).toHaveAttribute("max", "2026-06-14");
    fireEvent.change(screen.getByLabelText("Date In"), { target: { value: "2026-06-11" } });

    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    const ari = {
      firstName: "Ari",
      lastName: "Example",
      ageTier: "CHILD",
      isMember: false,
      stayStart: "2026-06-11",
      stayEnd: "2026-06-14",
    };
    expect(quoteBodies()[0]).toEqual({ officerGuests: [ari] });
    expect(approve).not.toBeDisabled();

    fireEvent.click(approve);
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).toEqual({
      status: "APPROVED",
      execute: true,
      adminNotes: "Added your grandchildren.",
      expectedVersion: 2,
      officerGuests: [ari],
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/recorded on the member's behalf/i)),
    );
  });

  it("figures for one list never arm the approval of another", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "ok" },
    });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: /Check the figures/i }));
    await screen.findByRole("list", { name: /What approving will do/i });
    const approve = screen.getByRole("button", { name: "Approve and apply" });
    expect(approve).not.toBeDisabled();
    await enterGuest("Bo");
    expect(approve).toBeDisabled();
  });

  it("a rejection carries no entry", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Please call the club." },
    });
    await enterGuest("Ari");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]).not.toHaveProperty("officerGuests");
  });
});
