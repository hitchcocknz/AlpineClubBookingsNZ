import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4285 review (`INV-PAY-043`): the payments cron's drain for an owed
 * `new-capture` alert. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * drives it end to end; this pins each branch: what it sends, what it clears
 * silently, and what it leaves owed.
 */
const mocks = vi.hoisted(() => ({
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  bookingFindUnique: vi.fn(),
  transactionFindUnique: vi.fn(),
  alert: vi.fn(),
  clubFormatValues: vi.fn(),
}));

vi.mock("@/lib/alert-cooldown", () => ({
  listOwedAlertKeys: (...args: unknown[]) => mocks.listOwedAlertKeys(...args),
  noteOwedAlertAttempt: (...args: unknown[]) => mocks.noteOwedAlertAttempt(...args),
  settleOwedAlert: (...args: unknown[]) => mocks.settleOwedAlert(...args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    paymentTransaction: { findUnique: (...args: unknown[]) => mocks.transactionFindUnique(...args) },
  },
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: () => mocks.clubFormatValues() }));
vi.mock("@/lib/duplicate-capture-guard", () => ({
  NEW_CAPTURE_ALERT_OWED_PREFIX: "duplicate-capture-new-capture-owed:",
  alertCaptureKeptWithoutRecordedSettler: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { drainOwedNewCaptureAlerts, NEW_CAPTURE_ALERT_DRAIN_AFTER_MS } from "@/lib/duplicate-capture-kept-alert-drain";

const KEY = "duplicate-capture-new-capture-owed:booking-1:pi_new";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = { currency: "NZD" };

function prime({ status = "COMPLETED", captureStatus = "SUCCEEDED" }: { status?: string; captureStatus?: string } = {}) {
  mocks.listOwedAlertKeys.mockResolvedValue([KEY]);
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    status,
    checkIn: new Date("2026-06-20"),
    checkOut: new Date("2026-06-22"),
    memberId: "member-1",
    member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
    organisation: null,
  });
  mocks.transactionFindUnique.mockResolvedValue({ status: captureStatus, amountCents: 20000 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clubFormatValues.mockResolvedValue(FORMAT);
  mocks.alert.mockResolvedValue("sent");
});

describe("the owed new-capture alert's drain (#4285 review)", () => {
  it("reads only due markers under its own prefix, an hour after they were owed, and reads nothing else when none is due", async () => {
    mocks.listOwedAlertKeys.mockResolvedValue([]);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(mocks.listOwedAlertKeys).toHaveBeenCalledWith({ prefix: "duplicate-capture-new-capture-owed:", now: NOW, retryAfterMs: NEW_CAPTURE_ALERT_DRAIN_AFTER_MS });
    expect(NEW_CAPTURE_ALERT_DRAIN_AFTER_MS).toBe(60 * 60 * 1000);
    expect(mocks.clubFormatValues).not.toHaveBeenCalled();
  });

  it("sends the kept-capture alert for a capture still holding money on a paid booking, as the settle would", async () => {
    prime();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith({
      booking: expect.objectContaining({ id: "booking-1" }),
      memberName: "Alice Example",
      paymentIntentId: "pi_new",
      amountCents: 20000,
      otherPaymentIntentId: null,
      otherHoldsMoney: false,
      reason: "new-capture",
      format: FORMAT,
    });
    expect(mocks.transactionFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: "pi_new" } }));
    // The alert clears the marker itself once delivered.
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded since", { captureStatus: "REFUNDED" }],
    ["never captured", { captureStatus: "PENDING" }],
    ["on a booking no longer paid", { status: "CANCELLED" }],
  ])("clears a marker with nothing to tell (%s) without an email", async (_label, state) => {
    prime(state);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("a send the day's cooldown blocked is tried again later; one that threw stays due for the next run", async () => {
    prime();
    mocks.alert.mockResolvedValueOnce("cooldown");
    await drainOwedNewCaptureAlerts(NOW);
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });

    vi.clearAllMocks();
    prime();
    mocks.clubFormatValues.mockResolvedValue(FORMAT);
    mocks.alert.mockResolvedValueOnce("send-threw");
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});
