import { describe, expect, it } from "vitest";
import { forcedCancelRefundMethod } from "@/lib/cancel-refund-method";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";

describe("forcedCancelRefundMethod (#3643 follow-up, the one home)", () => {
  it("forces an internet banking payment's cancellation refund to account credit", () => {
    expect(forcedCancelRefundMethod("INTERNET_BANKING")).toBe("credit");
  });

  it("forces nothing for a card payment or no payment", () => {
    expect(forcedCancelRefundMethod("STRIPE")).toBeNull();
    expect(forcedCancelRefundMethod(null)).toBeNull();
    expect(forcedCancelRefundMethod(undefined)).toBeNull();
  });

  it("forces the organiser's card for a joiner's booking the organiser paid for by card (#3653)", () => {
    expect(forcedCancelRefundMethod("STRIPE", true)).toBe("organiser_card");
  });

  it("forces a bank transfer to the organiser, never the joiner's credit, for one the organiser paid for by internet banking (#3949, owner decision 22 Oct 2026)", () => {
    expect(forcedCancelRefundMethod("INTERNET_BANKING", false, true)).toBe("organiser_by_hand");
    expect(forcedCancelRefundMethod("INTERNET_BANKING", false, false)).toBe("credit");
  });
});

describe("the cancellation hand-back's reason names its payee (#3949)", () => {
  it("the organiser on an organiser-paid place; the member's wording unchanged", async () => {
    const { cancellationHandBackReason } = await import("@/lib/manual-refund-task-copy");
    expect(cancellationHandBackReason({ bookingId: "b1", refundPercentage: 50, payee: "organiser" })).toBe(
      "Booking b1 cancelled by its joiner; the group organiser paid for it by internet banking, so the club refunds 50% (under the policy in effect at the time) to the group organiser by bank transfer (#3949).",
    );
    expect(cancellationHandBackReason({ bookingId: "b1", refundPercentage: 50, payee: "member" })).toBe(
      "Booking b1 cancelled — cash/manual settlement, refund by hand (50% under the policy in effect at the time).",
    );
  });
});

describe("paidByOrganiserCard (#3653)", () => {
  const child = { organiserSettled: true, parentBookingId: "organiser_bk", payment: { source: "STRIPE" } };

  it("is a card-settled organiser child, and nothing else", () => {
    expect(paidByOrganiserCard(child)).toBe(true);
    expect(paidByOrganiserCard({ ...child, payment: { source: "INTERNET_BANKING" } })).toBe(false);
    expect(paidByOrganiserCard({ ...child, organiserSettled: false })).toBe(false);
    expect(paidByOrganiserCard({ ...child, parentBookingId: null })).toBe(false);
    expect(paidByOrganiserCard({ ...child, payment: null })).toBe(false);
  });
});
