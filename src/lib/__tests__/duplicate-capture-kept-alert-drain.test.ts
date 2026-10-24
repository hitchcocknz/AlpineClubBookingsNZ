import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4285 review (`INV-PAY-043`): the payments cron's drain for an owed
 * `new-capture` alert. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * drives it end to end; this pins each branch: what it sends, what it clears
 * silently, what it leaves owed, and that it reads "another payment holding
 * money" through the guard's own telling reading (`readOtherSettledCaptureWhere`'s
 * `tellingWhere`, run for real here over a fake ledger), never a copy of its own.
 */
type Row = { id: string; source: string; status: string; stripePaymentIntentId: string | null };
type Operation = { type: string; paymentId: string; paymentTransactionId: string | null; paymentIntentId: string; allocationPlan: unknown };

const mocks = vi.hoisted(() => ({
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  bookingFindUnique: vi.fn(),
  transactionFindUnique: vi.fn(),
  transaction: vi.fn(),
  bookingEvents: [] as Array<{ type: string; snapshot: unknown }>,
  operations: [] as Operation[],
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

vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: vi.fn(),
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    bookingEvent: { findMany: async () => mocks.bookingEvents },
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.transactionFindUnique(...args),
      findMany: async () => [],
      findFirst: async ({ where }: { where: Parameters<typeof matchesOtherSettled>[1] }) =>
        mocks.rows.find((row) => matchesOtherSettled(row, where)) ?? null,
    },
    // Every operation in the fake ledger is in flight; the read's own `type` and `paymentId` filters are interpreted.
    paymentRecoveryOperation: {
      findMany: async ({ where }: { where: { paymentId: string; type: { in: string[] } } }) =>
        mocks.operations.filter((operation) => operation.paymentId === where.paymentId && where.type.in.includes(operation.type)),
    },
  };
  return {
    prisma: {
      ...client,
      // F3: one read-only snapshot, run against the same fake ledger.
      $transaction: async (fn: (tx: typeof client) => unknown, options: unknown) => {
        mocks.transaction(options);
        return fn(client);
      },
    },
  };
});
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
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { formatCents } from "@/lib/utils";

const KEY = "duplicate-capture-new-capture-owed:booking-1:pi_new";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = CLUB_FORMAT_TEST;

function refundOperation(overrides: Partial<Operation> = {}): Operation {
  return { type: "REFUND_BOOKING_MODIFICATION", paymentId: "payment-1", paymentTransactionId: null, paymentIntentId: "pi_primary", allocationPlan: null, ...overrides };
}

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
  mocks.operations = [];
  mocks.bookingEvents = [];
  mocks.clubFormatValues.mockResolvedValue(FORMAT);
  mocks.alert.mockResolvedValue("sent");
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
    // F3: judged in one read-only REPEATABLE READ snapshot.
    expect(mocks.transaction).toHaveBeenCalledWith({ isolationLevel: "RepeatableRead" });
  });

  it("F7: shows what the capture still holds after card refunds taken from it, whatever the reason", async () => {
    prime({ captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 4000 });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", amountCents: 16000 }));
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

  it.each([
    ["not yet planned (a cancel's refund plans newest first when it runs)", refundOperation()],
    ["planned with a slice of this capture", refundOperation({ allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 5000 }] })],
    ["on this capture's own row", refundOperation({ paymentTransactionId: "txn-new", allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["on this capture's intent", refundOperation({ paymentIntentId: "pi_new", allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["a superseded refund not yet planned", refundOperation({ type: "REFUND_SUPERSEDED_PAYMENT" })],
  ])("F2/F4: waits, neither sending nor clearing, while a card refund that may take from this capture is in flight (%s)", async (_label, operation) => {
    prime({ status: "CANCELLED" });
    mocks.operations.push(operation);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });
  });

  it.each([
    ["an additional-payment charge (#4272's review charge)", refundOperation({ type: "CREATE_ADDITIONAL_PAYMENT_INTENT" })],
    ["a cancel of an intent", refundOperation({ type: "CANCEL_PAYMENT_INTENT" })],
    ["a card refund planned on another capture only", refundOperation({ allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["a card refund on another payment", refundOperation({ paymentId: "payment-2" })],
  ])("F4: an operation that cannot take from this capture never holds the alert back (%s)", async (_label, operation) => {
    prime();
    mocks.operations.push(operation);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }));
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
  });

  it("F2/F3: a booking cancelled since is told as closed, with what the capture still holds after the cancel's refund", async () => {
    prime({ status: "CANCELLED", captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 15000 });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", paymentIntentId: "pi_new", amountCents: 5000, cancellationRefund: null }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["credit", { refundMethod: "credit", settledAmountCents: 10000 }, { method: "credit", amount: formatCents(10000, CLUB_FORMAT_TEST) }],
    ["by hand", { refundMethod: "manual", settledAmountCents: 10000 }, { method: "manual", amount: formatCents(10000, CLUB_FORMAT_TEST) }],
    ["card", { refundMethod: "card", settledAmountCents: 10000 }, { method: "card", amount: formatCents(10000, CLUB_FORMAT_TEST) }],
    ["no refund due", { refundMethod: "card", settledAmountCents: 0 }, { method: "none", amount: formatCents(0, CLUB_FORMAT_TEST) }],
  ])("F2: a closed alert names the cancellation's recorded refund (%s): a credit or by-hand refund never touched the capture", async (_label, recorded, expected) => {
    // A $200 credit-paid booking cancelled at a 50% tier: the stray capture still holds all $200.
    prime({ status: "CANCELLED" });
    mocks.bookingEvents = [
      { type: "CANCELLED", snapshot: { autoCancelledPastCheckIn: true } },
      { type: "CANCELLED", snapshot: { ...recorded, refundPercentage: 50 } },
    ];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", amountCents: 20000, cancellationRefund: expected }));
  });

  it("a paid booking's alert never reads or names a cancellation refund", async () => {
    prime();
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "credit", refundPercentage: 50, settledAmountCents: 10000 } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert.mock.calls[0]![0]).not.toHaveProperty("cancellationRefund");
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

  it("F1: a capture behind a dead cancel (handed to nobody) still holds money: told as a later payment, naming it", async () => {
    prime();
    mocks.rows.push({ id: "txn-dead-cancel", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_dead_cancel" });
    // The guard's refund-safety reading counts the exhausted cancel as live; the Xero (telling) reading does not.
    mocks.liveSuperseded.mockResolvedValue(["pi_dead_cancel"]);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_dead_cancel", otherHoldsMoney: true }),
    );
    expect(mocks.alert).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }));
  });

  it.each([
    ["owed back (#4227)", () => mocks.owningCaptures.mockResolvedValue(["pi_superseded"])],
    ["owned by a duplicate-capture refund", () => mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_superseded"])],
  ])("F1: the only other capture is one its machinery is sending back (%s): told as new-capture, never 'refund the other one'", async (_label, arrange) => {
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
    mocks.liveSuperseded.mockResolvedValue([]);
    mocks.owningCaptures.mockResolvedValue([]);
    mocks.duplicateRefundIntentIds.mockResolvedValue([]);
    mocks.alert.mockResolvedValueOnce("send-threw");
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});
