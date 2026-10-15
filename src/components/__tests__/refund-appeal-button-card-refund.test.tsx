// @vitest-environment jsdom

/**
 * #4124: the appeal form's maximum nets a card refund still being sent to the
 * owner's card. The form says so beside the maximum, so the lower figure is not
 * a mystery; with nothing still being sent it says nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "@/lib/__tests__/support/club-time-render";
import { RefundAppealButton } from "@/components/refund-appeal-button";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue({ json: async () => [] });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openForm(cardRefundOwedCents?: number) {
  render(<RefundAppealButton bookingId="booking-1" maxRefundableCents={7500} cardRefundOwedCents={cardRefundOwedCents} />);
  fireEvent.click(await screen.findByRole("button", { name: "Request Refund Appeal" }));
}

describe("refund appeal form, a card refund still being sent (#4124)", () => {
  it("says how much is still being refunded to the card beside the maximum", async () => {
    await openForm(2500);

    expect(screen.getByText(/maximum \$75\.00/)).toBeTruthy();
    expect(screen.getByText("$25.00 is still being refunded to your card.")).toBeTruthy();
  });

  it("CONTROL: says nothing when no card refund is still being sent", async () => {
    await openForm();

    expect(screen.queryByText(/still being refunded/)).toBeNull();
  });
});
