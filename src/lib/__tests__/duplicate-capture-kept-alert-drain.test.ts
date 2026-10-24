import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4285 review (`INV-PAY-043`): the payments cron's drain for an owed
 * `new-capture` alert. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * drives it end to end; this pins each branch: what it sends, what it clears
 * silently, what it leaves owed, and that it reads "another payment holding
 * money" through the guard's own telling reading (`readOtherSettledCaptureWhere`'s
 * `readTellingWhere`, run for real here over a fake ledger), never a copy of its own.
 */
type Row = { id: string; source: string; status: string; stripePaymentIntentId: string | null };
type Operation = {
  type: string;
  paymentId: string;
  paymentTransactionId: string | null;
  paymentIntentId: string;
  allocationPlan: unknown;
  status: string;
  attempts: number;
  nextRetryAt: Date | null;
};
type InFlightArm = { status: string; attempts?: { lt: number }; nextRetryAt?: { not: null } };

const mocks = vi.hoisted(() => ({
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  bookingFindUnique: vi.fn(),
  transactionFindUnique: vi.fn(),
  transaction: vi.fn(),
  bookingEvents: [] as Array<{ type: string; snapshot: unknown }>,
  operations: [] as Operation[],
  /** The member cancel's card refund row (`booking_cancel_refund_recovery_<booking>`), or null. */
  cancelRefundRow: null as { id: string; status: string; attempts: number; nextRetryAt: Date | null } | null,
  /** A "Paid another way" close record on that row (`closeKeysOf`), or null. */
  closeRecord: null as { amountCents: number | null; raisedAmountCents: number | null } | null,
  cancelRefundRowWhere: vi.fn(),
  /** The card refunds recorded against the capture (`PaymentRefund`), summed. */
  cardRefundedCents: 0,
  cardRefundWhere: vi.fn(),
  alert: vi.fn(),
  clubFormatValues: vi.fn(),
  liveSuperseded: vi.fn(),
  owningCaptures: vi.fn(),
  duplicateRefundIntentIds: vi.fn(),
  /** The duplicate-capture refunds still holding their captures (the telling reading's half, #4285 review). */
  duplicateRefundsHolding: vi.fn(),
  executeRaw: vi.fn(),
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

/** `PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`'s arms, interpreted - or every row when the read asks for none. */
function matchesInFlight(operation: Operation, where: { OR?: InFlightArm[] }) {
  if (!where.OR) return true;
  return where.OR.some(
    (arm) =>
      operation.status === arm.status &&
      (arm.attempts === undefined || operation.attempts < arm.attempts.lt) &&
      (arm.nextRetryAt === undefined || operation.nextRetryAt !== null),
  );
}

vi.mock("@/lib/prisma", () => {
  const client = {
    $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    bookingEvent: { findMany: async () => mocks.bookingEvents },
    paymentRefund: {
      aggregate: async ({ where }: { where: unknown }) => {
        mocks.cardRefundWhere(where);
        return { _sum: { amountCents: mocks.cardRefundedCents || null } };
      },
    },
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.transactionFindUnique(...args),
      findMany: async () => [],
      findFirst: async ({ where }: { where: Parameters<typeof matchesOtherSettled>[1] }) =>
        mocks.rows.find((row) => matchesOtherSettled(row, where)) ?? null,
    },
    // F7: the read's own `type`, `paymentId` and in-flight filters are interpreted, so a dead row is read as the drain asks.
    paymentRecoveryOperation: {
      findMany: async ({ where }: { where: { paymentId: string; type: { in: string[] }; OR?: InFlightArm[] } }) =>
        mocks.operations.filter(
          (operation) => operation.paymentId === where.paymentId && where.type.in.includes(operation.type) && matchesInFlight(operation, where),
        ),
      findUnique: async ({ where }: { where: unknown }) => {
        mocks.cancelRefundRowWhere(where);
        return mocks.cancelRefundRow;
      },
    },
    manualRefundTask: { findFirst: async () => mocks.closeRecord },
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
  listDuplicateRefundIntentIdsOwningCaptures: (...args: unknown[]) => mocks.duplicateRefundsHolding(...args),
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

/** A card refund row, in flight unless the case says otherwise. */
function refundOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    type: "REFUND_BOOKING_MODIFICATION",
    paymentId: "payment-1",
    paymentTransactionId: null,
    paymentIntentId: "pi_primary",
    allocationPlan: null,
    status: "PENDING",
    attempts: 0,
    nextRetryAt: NOW,
    ...overrides,
  };
}

/** Dead: FAILED with no retry left - the runner never sends it again. */
const DEAD = { status: "FAILED", attempts: 5, nextRetryAt: null } as const;

function prime({
  status = "COMPLETED",
  captureStatus = "SUCCEEDED",
  refundedAmountCents = 0,
  cardRefundedCents = refundedAmountCents,
}: { status?: string; captureStatus?: string; refundedAmountCents?: number; cardRefundedCents?: number } = {}) {
  mocks.cardRefundedCents = cardRefundedCents;
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
  // By default every duplicate-capture refund still holds its capture, as one at any status does until it failed later.
  mocks.duplicateRefundsHolding.mockImplementation(() => mocks.duplicateRefundIntentIds());
  mocks.cancelRefundRow = null;
  mocks.closeRecord = null;
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
    // F3: judged in one read-only REPEATABLE READ snapshot, the transaction made read-only before any read.
    expect(mocks.transaction).toHaveBeenCalledWith({ isolationLevel: "RepeatableRead" });
    expect(String((mocks.executeRaw.mock.calls[0] as unknown[])[0])).toContain("SET TRANSACTION READ ONLY");
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.bookingFindUnique.mock.invocationCallOrder[0]!);
  });

  it("F7: shows what the card still holds after card refunds recorded against it, whatever the reason", async () => {
    prime({ captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 4000 });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", amountCents: 16000 }));
    // The capture's own card refunds, by row or intent, that Stripe has not refused.
    expect(mocks.cardRefundWhere).toHaveBeenCalledWith({
      OR: [{ paymentTransactionId: "txn-new" }, { stripePaymentIntentId: "pi_new" }],
      status: { notIn: ["failed", "canceled"] },
    });
  });

  it.each([
    ["in full", { captureStatus: "REFUNDED", refundedAmountCents: 20000, cardRefundedCents: 0 }, 20000],
    ["in part", { captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 10000, cardRefundedCents: 0 }, 20000],
  ])("F2: a refund as account credit marks the capture refunded (%s) but leaves the money on the card: still told, with what the card holds", async (_label, state, held) => {
    prime({ status: "CANCELLED", ...state });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", amountCents: held }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded to the card since", { captureStatus: "REFUNDED", refundedAmountCents: 20000 }],
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

  const money = (cents: number) => formatCents(cents, CLUB_FORMAT_TEST);

  it.each([
    ["credit", { refundMethod: "credit", settledAmountCents: 10000 }, { method: "credit", amount: money(10000) }],
    ["by hand", { refundMethod: "manual", settledAmountCents: 10000 }, { method: "manual", amount: money(10000) }],
    ["no refund due", { refundMethod: "card", settledAmountCents: 0 }, { method: "none" }],
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

  it.each([
    ["its row SUCCEEDED: sent", { id: "op-cancel", status: "SUCCEEDED", attempts: 1, nextRetryAt: null }, null, "sent"],
    ["its row dead: planned, never sent", { id: "op-cancel", ...DEAD }, null, "not-sent"],
    ["its row still on its way", { id: "op-cancel", status: "FAILED", attempts: 2, nextRetryAt: NOW }, null, "not-sent"],
    ["closed as paid another way", { id: "op-cancel", status: "SUCCEEDED", attempts: 1, nextRetryAt: null }, { amountCents: 10000, raisedAmountCents: 10000 }, "paid-another-way"],
    ["no row (a cancel from before it existed)", null, null, "unrecorded"],
  ])("#4285 review 7 F1: a card cancel's refund is said as its recovery row stands (%s), never as planned", async (_label, row, close, standing) => {
    prime({ status: "CANCELLED" });
    mocks.cancelRefundRow = row;
    mocks.closeRecord = close;
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000 } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-closed", cancellationRefund: { method: "card", card: { amount: money(10000), standing }, byBank: null, toCheck: null } }),
    );
    // The member cancel's own row, by its key.
    expect(mocks.cancelRefundRowWhere).toHaveBeenCalledWith({ idempotencyKey: "booking_cancel_refund_recovery_booking-1" });
  });

  it("#4285 review 7 F1/F7: a dead card refund planned on this very capture neither holds the alert back nor is said to have refunded it", async () => {
    prime({ status: "CANCELLED" });
    const dead = refundOperation({ ...DEAD, paymentIntentId: "pi_new", allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 10000 }] });
    mocks.operations.push(dead);
    mocks.cancelRefundRow = { id: "op-cancel", status: dead.status, attempts: dead.attempts, nextRetryAt: dead.nextRetryAt };
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000 } }];

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "new-capture-closed",
        amountCents: 20000,
        cancellationRefund: { method: "card", card: { amount: money(10000), standing: "not-sent" }, byBank: null, toCheck: null },
      }),
    );
  });

  it.each([
    ["the card carried part", { cardCents: 6000, bankCents: 3000, checkCents: 1000 }, { amount: money(6000), standing: "sent" }],
    ["the card carried nothing", { cardCents: 0, bankCents: 7000, checkCents: 3000 }, null],
  ])("#4285 review 7 F1: a card refund shortfall says the parts owed by bank transfer and for the club to check beside the card's (%s)", async (_label, cardShortfall, card) => {
    prime({ status: "CANCELLED" });
    mocks.cancelRefundRow = { id: "op-cancel", status: "SUCCEEDED", attempts: 1, nextRetryAt: null };
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000, cardShortfall } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellationRefund: { method: "card", card, byBank: money(cardShortfall.bankCents), toCheck: money(cardShortfall.checkCents) },
      }),
    );
    // No card part, no card refund row to read.
    expect(mocks.cancelRefundRowWhere).toHaveBeenCalledTimes(card ? 1 : 0);
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

  it("#4285 review 7 F6: a capture whose duplicate-capture refund failed later, with nothing owing it again, still holds money: named, never 'no other payment'", async () => {
    prime();
    mocks.rows.push({ id: "txn-dup", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_dup" });
    // Its refund operation owns it at any status for the refund-safety reading; the telling reading no longer counts it.
    mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_dup"]);
    mocks.duplicateRefundsHolding.mockResolvedValue([]);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_dup", otherHoldsMoney: true }),
    );
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
    mocks.duplicateRefundsHolding.mockResolvedValue([]);
    mocks.alert.mockResolvedValueOnce("send-threw");
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});
