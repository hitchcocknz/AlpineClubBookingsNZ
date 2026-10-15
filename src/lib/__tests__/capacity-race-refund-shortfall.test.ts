import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4125: the officers' once-ever alert for the part of a capacity-race charge
 * no card refund covers - what backs the booking page's "the club will be in
 * touch about the remaining $X". The once-ever rule is the real
 * `sendAdminAlertOnceEver`; its claim and the send are doubled.
 */
const doubles = vi.hoisted(() => ({
  claim: vi.fn(),
  alertOfficers: vi.fn(),
}));
vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/alert-cooldown")),
  claimAlertCooldown: doubles.claim,
  releaseAlertCooldown: vi.fn(async () => {}),
  deferAlertCooldown: vi.fn(async () => {}),
}));
vi.mock("@/lib/payment-recovery-alert", () => ({
  alertPaymentRecoveryOfficers: doubles.alertOfficers,
  NOBODY_ALERTED: { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  alertCapacityRaceRefundShortfall,
  capacityRaceRefundShortfallAlertKey,
} from "@/lib/capacity-race-refund-shortfall";

const SENT = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };

describe("the capacity race's refund shortfall alert (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.claim.mockResolvedValue(true);
    doubles.alertOfficers.mockResolvedValue(SENT);
  });

  it("sends nothing when the plan covers the charge", async () => {
    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 10000 }, CLUB_FORMAT_TEST)).toBe(false);
    expect(doubles.claim).not.toHaveBeenCalled();
    expect(doubles.alertOfficers).not.toHaveBeenCalled();
  });

  it("MUTATION: a partial plan tells the officers the remainder, once ever on the booking", async () => {
    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).toBe(true);

    expect(doubles.claim).toHaveBeenCalledWith(expect.objectContaining({ key: capacityRaceRefundShortfallAlertKey("booking-1") }));
    expect(capacityRaceRefundShortfallAlertKey("booking-1")).toBe("capacity-race-refund-shortfall:booking-1");
    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        paymentIntentId: "pi_1",
        amountCents: 2000,
        errorMessage: expect.stringContaining("only $80.00 of the $100.00 charge refundable"),
      }),
      CLUB_FORMAT_TEST,
    );
    expect(doubles.alertOfficers.mock.calls[0]?.[0]).toMatchObject({ errorMessage: expect.stringContaining("refund the member the $20.00 by hand") });
  });

  it("an empty plan tells them the whole charge", async () => {
    await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 0 }, CLUB_FORMAT_TEST);

    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10000, errorMessage: expect.stringContaining("nothing of the $100.00 charge refundable by card") }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a claim already held (a redelivered webhook) sends nothing more", async () => {
    doubles.claim.mockResolvedValue(false);

    expect(await alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).toBe(false);
    expect(doubles.alertOfficers).not.toHaveBeenCalled();
  });

  it("never throws when the send does", async () => {
    doubles.alertOfficers.mockRejectedValue(new Error("smtp down"));

    await expect(alertCapacityRaceRefundShortfall({ bookingId: "booking-1", paymentIntentId: "pi_1", chargedCents: 10000, plannedRefundCents: 8000 }, CLUB_FORMAT_TEST)).resolves.toBe(false);
  });
});
