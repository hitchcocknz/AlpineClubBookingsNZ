import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4285 review (`INV-PAY-043`): the payments cron's drain for an owed
 * `new-capture` alert. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * drives it end to end; this pins each branch: what it sends, what it clears
 * silently, what it leaves owed, and that it reads "another payment holding
 * money" through the guard's own reading (`readOtherSettledCaptureWhere`, run
 * for real here over a fake ledger), never a copy of its own.
 */
type Row = { id: string; source: string; status: string; stripePaymentIntentId: string | null };

const mocks = vi.hoisted(() => ({
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  bookingFindUnique: vi.fn(),
  transactionFindUnique: vi.fn(),
  recoveryFindFirst: vi.fn(),
  alert: vi.fn(),
  clubFormatValues: vi.fn(),
  liveSuperseded: vi.fn(),
  owningCaptures: vi.fn(),
  duplicateRefundIntentIds: vi.fn(),
  rows: [] as Row[],
}));

vi.mock("@/lib/alert-cooldown", () => ({
  listOwedAlertKeys: (...args: unknown[]) => mocks.listOwedAlertKeys(...args),
  noteOwedAlertAttempt: (...args: unknown[]) => mocks.noteOwedAlertAttempt(...args),
  settleOwedAlert: (...args: unknown[]) => mocks.settleOwedAlert(...args),
  releaseAlertCooldown: vi.fn(),
}));

/** The guard's `otherSettledCaptureWhere` shape, interpreted (STRIPE arm with its exclusions, non-STRIPE arm). */
function matchesOtherSettled(row: Row, where: {
  paymentId: string;
  status: { in: string[] };
  OR: Array<{ source?: string | { not: string }; stripePaymentIntentId?: { not: string; notIn: string[] } }>;
}) {
  if (!where.status.in.includes(row.status)) return false;
  return where.OR.some((arm) => {
    if (typeof arm.source === "string" && row.source !== arm.source) return false;
    if (arm.source && typeof arm.source === "object" && row.source === arm.source.not) return false;
    if (arm.stripePaymentIntentId) {
      if (row.stripePaymentIntentId === null) return false;
      if (row.stripePaymentIntentId === arm.stripePaymentIntentId.not) return false;
      if (arm.stripePaymentIntentId.notIn.includes(row.stripePaymentIntentId)) return false;
    }
    return true;
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.transactionFindUnique(...args),
      findMany: async () => [],
      findFirst: async ({ where }: { where: Parameters<typeof matchesOtherSettled>[1] }) =>
        mocks.rows.find((row) => matchesOtherSettled(row, where)) ?? null,
    },
    paymentRecoveryOperation: { findFirst: (...args: unknown[]) => mocks.recoveryFindFirst(...args) },
  },
}));
vi.mock("@/lib/superseded-intent-ownership", () => ({
  listLiveSupersededIntentIds: (...args: unknown[]) => mocks.liveSuperseded(...args),
  listSupersededIntentIdsOwningCaptures: (...args: unknown[]) => mocks.owningCaptures(...args),
  findLiveSupersededIntentOperation: vi.fn(),
}));
vi.mock("@/lib/duplicate-capture-ownership", () => ({
  listDuplicateCaptureRefundIntentIds: (...args: unknown[]) => mocks.duplicateRefundIntentIds(...args),
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: () => mocks.clubFormatValues() }));
vi.mock("@/lib/duplicate-capture-guard", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/duplicate-capture-guard")),
  alertCaptureKeptWithoutRecordedSettler: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { drainOwedNewCaptureAlerts, NEW_CAPTURE_ALERT_DRAIN_AFTER_MS } from "@/lib/duplicate-capture-kept-alert-drain";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";

const KEY = "duplicate-capture-new-capture-owed:booking-1:pi_new";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = { currency: "NZD" };

function prime({
  status = "COMPLETED",
  captureStatus = "SUCCEEDED",
  refundedAmountCents = 0,
}: { status?: string; captureStatus?: string; refundedAmountCents?: number } = {}) {
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
  mocks.transactionFindUnique.mockResolvedValue({ id: "txn-new", paymentId: "payment-1", status: captureStatus, amountCents: 20000, refundedAmountCents });
  mocks.rows = [{ id: "txn-new", source: "STRIPE", status: captureStatus, stripePaymentIntentId: "pi_new" }];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.clubFormatValues.mockResolvedValue(FORMAT);
  mocks.alert.mockResolvedValue("sent");
  mocks.recoveryFindFirst.mockResolvedValue(null);
  mocks.liveSuperseded.mockResolvedValue([]);
  mocks.owningCaptures.mockResolvedValue([]);
  mocks.duplicateRefundIntentIds.mockResolvedValue([]);
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
    // The alert clears the marker itself once delivered.
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded since", { captureStatus: "REFUNDED" }],
    ["never captured", { captureStatus: "PENDING" }],
  ])("clears a marker with nothing to tell (%s) without an email", async (_label, state) => {
    prime(state);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("clears a marker whose booking is gone without an email", async () => {
    prime();
    mocks.bookingFindUnique.mockResolvedValue(null);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("F2: waits, neither sending nor clearing, while a refund operation on the payment is in flight", async () => {
    prime({ status: "CANCELLED" });
    mocks.recoveryFindFirst.mockResolvedValue({ id: "op-refund" });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.recoveryFindFirst).toHaveBeenCalledWith({ where: { paymentId: "payment-1", ...PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE }, select: { id: true } });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });
  });

  it("F2/F3: a booking cancelled since is told as closed, with what the capture still holds after the cancel's refund", async () => {
    prime({ status: "CANCELLED", captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 15000 });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", paymentIntentId: "pi_new", amountCents: 5000 }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["the superseded-payment machinery", () => mocks.owningCaptures.mockResolvedValue(["pi_new"])],
    ["a duplicate-capture refund", () => mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_new"])],
  ])("clears silently a capture %s owns: that machinery refunds it and tells the admins itself", async (_label, arrange) => {
    prime();
    arrange();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("F1/F3: another payment the guard counts as holding money is told as a later payment, naming it", async () => {
    prime();
    mocks.rows.push({ id: "txn-other", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_other" });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_other", otherHoldsMoney: true }),
    );
  });

  it("a bank payment holding money counts as the other payment too (any source, as the guard reads it)", async () => {
    prime();
    mocks.rows.push({ id: "txn-bank", source: "INTERNET_BANKING", status: "SUCCEEDED", stripePaymentIntentId: null });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: null, otherHoldsMoney: true }));
  });

  it.each([
    ["live", () => mocks.liveSuperseded.mockResolvedValue(["pi_superseded"])],
    ["owed back (#4227)", () => mocks.owningCaptures.mockResolvedValue(["pi_superseded"])],
    ["owned by a duplicate-capture refund", () => mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_superseded"])],
  ])("F1: the only other capture is one the guard does not count (%s): told as new-capture, never 'refund the other one'", async (_label, arrange) => {
    prime();
    mocks.rows.push({ id: "txn-superseded", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_superseded" });
    arrange();

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", otherPaymentIntentId: null, otherHoldsMoney: false }));
  });

  it("a send the day's cooldown blocked is tried again later; one that threw stays due for the next run", async () => {
    prime();
    mocks.alert.mockResolvedValueOnce("cooldown");
    await drainOwedNewCaptureAlerts(NOW);
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });

    vi.clearAllMocks();
    prime();
    mocks.clubFormatValues.mockResolvedValue(FORMAT);
    mocks.recoveryFindFirst.mockResolvedValue(null);
    mocks.liveSuperseded.mockResolvedValue([]);
    mocks.owningCaptures.mockResolvedValue([]);
    mocks.duplicateRefundIntentIds.mockResolvedValue([]);
    mocks.alert.mockResolvedValueOnce("send-threw");
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});
