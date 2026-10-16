import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4159 review round 2 (F2, `INV-PAY-134`): refund money a charge's refunded
 * total could not hold reaches the officers, once per charge and refund-row
 * total, through the payment recovery alert - never only the error log.
 */
const doubles = vi.hoisted(() => ({
  findUnique: vi.fn(),
  onceEver: vi.fn(async (args: { send: () => Promise<unknown> }) => {
    await args.send();
    return true;
  }),
  alertOfficers: vi.fn(async () => ({ sent: 1 })),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentTransaction: { findUnique: doubles.findUnique } } }));
vi.mock("@/lib/admin-alert-once", () => ({ sendAdminAlertOnceEver: doubles.onceEver }));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: doubles.alertOfficers, NOBODY_ALERTED: { sent: 0 } }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));
vi.mock("@/lib/logger", () => ({ default: { error: doubles.error, warn: vi.fn(), info: vi.fn() } }));

import { alertCardRefundCapOverflow, cardRefundCapOverflowAlertKey } from "@/lib/card-refund-cap-overflow";

const OVERFLOW = { paymentId: "payment-1", paymentTransactionId: "txn-race", discardedCents: 5_000, recordedRefundCents: 5_000 };

describe("a card refund past its charge alerts the officers (#4159 F2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.findUnique.mockResolvedValue({ stripePaymentIntentId: "pi_race", payment: { bookingId: "booking-1" } });
  });

  it("MUTATION: alerts once per charge and refund-row total, naming the booking, the discarded money and the paid-twice risk", async () => {
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(true);
    expect(doubles.onceEver).toHaveBeenCalledWith(expect.objectContaining({ key: "card-refund-cap-overflow:txn-race:5000" }));
    expect(doubles.alertOfficers).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking-1",
        amountCents: 5_000,
        paymentIntentId: "pi_race",
        errorMessage: expect.stringMatching(/^A card refund took this booking's card charge past what was charged: \$50\.00 of refunds.*paid back twice/),
      }),
      expect.anything(),
    );
  });

  it("a new refund on the same charge is a new alert; a replay of the same refunds is not", () => {
    expect(cardRefundCapOverflowAlertKey(OVERFLOW)).toBe(cardRefundCapOverflowAlertKey({ ...OVERFLOW, discardedCents: 1 }));
    expect(cardRefundCapOverflowAlertKey(OVERFLOW)).not.toBe(cardRefundCapOverflowAlertKey({ ...OVERFLOW, recordedRefundCents: 8_000 }));
  });

  it("never throws: a charge with no booking, or a failing alert, is logged as an error", async () => {
    doubles.findUnique.mockResolvedValueOnce(null);
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    doubles.onceEver.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    expect(doubles.error).toHaveBeenCalledTimes(2);
  });
});
