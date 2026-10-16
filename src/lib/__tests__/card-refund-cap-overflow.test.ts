import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4159 review round 2 (F2, `INV-PAY-135`): refund money a charge's refunded
 * total could not hold reaches the officers, once per charge and refund-row
 * total, through the payment recovery alert - never only the error log.
 */
const doubles = vi.hoisted(() => ({
  findUnique: vi.fn(),
  handBacks: vi.fn(async () => 0),
  onceEver: vi.fn(async (args: { send: () => Promise<unknown> }) => {
    await args.send();
    return true;
  }),
  alertOfficers: vi.fn(async () => ({ sent: 1 })),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentTransaction: { findUnique: doubles.findUnique }, manualRefundTask: { count: doubles.handBacks } } }));
vi.mock("@/lib/admin-alert-once", () => ({ sendAdminAlertOnceEver: doubles.onceEver }));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers: doubles.alertOfficers, NOBODY_ALERTED: { sent: 0 } }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));
vi.mock("@/lib/logger", () => ({ default: { error: doubles.error, warn: vi.fn(), info: vi.fn() } }));

import { alertCardRefundCapOverflow, cardRefundCapOverflowAlertKey } from "@/lib/card-refund-cap-overflow";
import { NOT_NON_CANCELLATION_HAND_BACK_WHERE } from "@/lib/manual-refund-task-settlement-rules";

const OVERFLOW = { paymentId: "payment-1", paymentTransactionId: "txn-race", discardedCents: 5_000, recordedRefundCents: 5_000, countedRefundIds: ["re_b", "re_a"] };

describe("a card refund past its charge alerts the officers (#4159 F2, round 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.findUnique.mockResolvedValue({ stripePaymentIntentId: "pi_race", payment: { bookingId: "booking-1" } });
  });

  it("MUTATION (round 3, 3): with a hand-back completed on the payment, says the member may have been paid twice", async () => {
    doubles.handBacks.mockResolvedValueOnce(1);
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(true);
    // INV-PAY-117: an edit's refund hand-back, or an approved refund request's, is not a cancellation's.
    expect(doubles.handBacks).toHaveBeenCalledWith({ where: { paymentId: "payment-1", kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", ...NOT_NON_CANCELLATION_HAND_BACK_WHERE } });
    expect(doubles.onceEver).toHaveBeenCalledWith(expect.objectContaining({ key: cardRefundCapOverflowAlertKey(OVERFLOW) }));
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

  it("MUTATION (round 3, 3): with none, names record drift or account credit and never paid twice", async () => {
    await alertCardRefundCapOverflow(OVERFLOW);
    const [[{ errorMessage }]] = doubles.alertOfficers.mock.calls as unknown as [[{ errorMessage: string }]];
    expect(errorMessage).toContain("The charge's records already read it fully refunded, with no hand-back behind it (record drift, or account credit given back). Check the charge in Stripe");
    expect(errorMessage).not.toMatch(/twice/);
  });

  it("MUTATION (round 3, 4): keyed on the refunds the charge counts - the same set in any order is one alert; a new refund, even at the same total, is another", () => {
    const key = cardRefundCapOverflowAlertKey(OVERFLOW);
    expect(key).toMatch(/^card-refund-cap-overflow:txn-race:[0-9a-f]{24}$/);
    expect(cardRefundCapOverflowAlertKey({ ...OVERFLOW, countedRefundIds: ["re_a", "re_b"], discardedCents: 1 })).toBe(key);
    expect(cardRefundCapOverflowAlertKey({ ...OVERFLOW, countedRefundIds: ["re_a", "re_c"] })).not.toBe(key);
  });

  it("never throws: a charge with no booking, or a failing alert, is logged as an error", async () => {
    doubles.findUnique.mockResolvedValueOnce(null);
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    doubles.onceEver.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertCardRefundCapOverflow(OVERFLOW)).resolves.toBe(false);
    expect(doubles.error).toHaveBeenCalledTimes(2);
  });
});
