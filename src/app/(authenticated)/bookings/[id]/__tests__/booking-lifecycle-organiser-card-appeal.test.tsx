import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/cancel-booking-button", () => ({ CancelBookingButton: () => null }));
vi.mock("@/components/delete-booking-button", () => ({ DeleteBookingButton: () => null }));
vi.mock("@/components/refund-appeal-button", () => ({
  RefundAppealButton: ({ maxRefundableCents }: { maxRefundableCents: number }) => (
    <button type="button">Appeal up to {maxRefundableCents}</button>
  ),
}));

import { BookingLifecycleActions } from "../_components/booking-lifecycle-actions";

/**
 * #3956 round 3: on a cancelled booking the group organiser paid for by card, a
 * zero appeal ceiling that is only a wait for the group cancellation's own
 * refund shows a line saying so, not a silently missing appeal.
 */
const WAITING = "The group's cancellation refund is still being processed; you can appeal once it has been made.";

function render(options: { maxRefundableCents: number; organiserCardAppealPending?: boolean }) {
  return renderToStaticMarkup(
    <BookingLifecycleActions
      booking={{ id: "booking-1", status: "CANCELLED", noEmails: false, payment: { status: "SUCCEEDED" } } as never}
      viewer={{ canManageBooking: true, actingOnBehalf: false, viewerAuthorizationRole: "USER" } as never}
      access={{ canCancel: false, isDeleted: false } as never}
      payment={{ maxRefundableCents: options.maxRefundableCents } as never}
      messages={{ refundAppealDescription: "" } as never}
      canDeleteDraft={false}
      canSoftDeleteCancelled={false}
      backHref="/bookings"
      organiserCardAppeal
      organiserCardAppealPending={options.organiserCardAppealPending ?? false}
    />,
  );
}

describe("booking page organiser-card appeal while the group refund is pending (#3956)", () => {
  it("hides the appeal button and says the appeal waits", () => {
    const html = render({ maxRefundableCents: 0, organiserCardAppealPending: true });
    expect(html).toContain(WAITING.replace("'", "&#x27;"));
    expect(html).not.toContain("<button");
  });

  it("offers the appeal, with no waiting line, once the refund is made", () => {
    const html = render({ maxRefundableCents: 4_000 });
    expect(html).toContain("Appeal up to 4000");
    expect(html).not.toContain("still being processed");
  });

  it("shows neither the button nor the waiting line when the ceiling is zero and nothing is pending", () => {
    const html = render({ maxRefundableCents: 0 });
    expect(html).not.toContain("<button");
    expect(html).not.toContain("still being processed");
  });
});
