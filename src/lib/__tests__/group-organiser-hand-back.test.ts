import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";

/**
 * #4042 (`INV-PAY-123`): the hand-back an organiser's Internet Banking group
 * cancel keeps for the organiser - created by the first share, grown by each
 * later one while OPEN, supplemented per joiner once closed - and its alert.
 * Where the cancel calls these is `group-cancel.test.ts`; the row against the
 * real schema and a completion that moves nothing are
 * `booking-ledger-group-settlement.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  claimedFindUniqueOrThrow: vi.fn(),
  bookingFindMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  organiserFindUniqueOrThrow: vi.fn(),
  sendAdminManualRefundTaskAlert: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUniqueOrThrow: mocks.organiserFindUniqueOrThrow } },
}));
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: mocks.sendAdminManualRefundTaskAlert }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import {
  alertGroupOrganiserHandBack,
  composeGroupHandBackReason,
  readGroupHandBackReasonShares,
  recordGroupOrganiserHandBackShare,
} from "@/lib/group-organiser-hand-back";
import {
  groupOrganiserHandBackOccurrenceKey,
  isGroupOrganiserHandBackTask,
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  manualRefundTask: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
  booking: { findUniqueOrThrow: mocks.claimedFindUniqueOrThrow, findMany: mocks.bookingFindMany },
  bookingLedgerLine: { findMany: mocks.ledgerFindMany },
} as unknown as Parameters<typeof recordGroupOrganiserHandBackShare>[0];

const INPUT = {
  settlementId: "settle-1",
  organiserBookingId: "org-booking",
  plan: new Map([["child-a", 4500], ["child-b", 3000], ["child-c", 0]]),
  claimedChildId: "child-a",
  format: CLUB_FORMAT_TEST,
};
const KEY = "group-organiser-hand-back:settle-1";

const named = (firstName: string, lastName: string) => ({ member: { firstName, lastName }, organisation: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(null);
  mocks.claimedFindUniqueOrThrow.mockResolvedValue(named("Ana", "Joiner"));
  mocks.ledgerFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockImplementation(async ({ data }: { data: { reason: string } }) => ({ id: "task-1", reason: data.reason }));
  mocks.sendAdminManualRefundTaskAlert.mockResolvedValue(undefined);
});

describe("recordGroupOrganiserHandBackShare", () => {
  it("the first share creates ONE cancellation hand-back on the organiser's booking, for that share, with no payment", async () => {
    const raised = await recordGroupOrganiserHandBackShare(tx, INPUT);

    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { occurrenceKey: KEY }, select: expect.any(Object) });
    const [{ data }] = mocks.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toEqual({
      bookingId: "org-booking",
      amountCents: 4500,
      raisedAmountCents: 4500,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: KEY,
      reason: "Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $45.00 by bank transfer. Joiners' shares: Ana Joiner $45.00.",
    });
    // No paymentId: the joiners' refunds are already on their own payments.
    expect(data).not.toHaveProperty("paymentId");
    expect(raised).toEqual({ id: "task-1", amountCents: 4500, reason: data.reason, created: true });
  });

  it("a later share grows the OPEN task by a status-guarded update and lists itself; it alerts nobody", async () => {
    mocks.findUnique.mockResolvedValueOnce({
      id: "task-1",
      status: ManualRefundTaskStatus.OPEN,
      amountCents: 4500,
      reason: "Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $45.00 by bank transfer. Joiners' shares: Ana Joiner $45.00.",
    });
    mocks.claimedFindUniqueOrThrow.mockResolvedValue(named("Ben", "Joiner"));

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    const reason = "Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $75.00 by bank transfer. Joiners' shares: Ana Joiner $45.00, Ben Joiner $30.00.";
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "task-1", status: ManualRefundTaskStatus.OPEN },
      data: { amountCents: { increment: 3000 }, raisedAmountCents: { increment: 3000 }, reason },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(raised).toEqual({ id: "task-1", amountCents: 7500, reason, created: false });
  });

  it("a share booked after the task was closed raises a supplementary task keyed per joiner, once", async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: "task-1", status: ManualRefundTaskStatus.COMPLETED, amountCents: 4500, reason: "r" });
    mocks.claimedFindUniqueOrThrow.mockResolvedValue(named("Ben", "Joiner"));

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    const [{ data }] = mocks.create.mock.calls[0] as [{ data: { occurrenceKey: string; amountCents: number; reason: string } }];
    expect(data).toMatchObject({ occurrenceKey: `${KEY}:child-b`, amountCents: 3000, raisedAmountCents: 3000 });
    expect(data.reason).toContain("recorded after the group's repayment task was closed: repay the organiser $30.00");
    expect(raised).toMatchObject({ amountCents: 3000, created: true });
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: data.occurrenceKey })).toBe(true);

    // Its own supplementary task already there: nothing more.
    mocks.create.mockClear();
    mocks.findUnique.mockResolvedValueOnce({ id: "task-1", status: ManualRefundTaskStatus.COMPLETED, amountCents: 4500, reason: "r" }).mockResolvedValueOnce({ id: "task-2" });
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" })).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a cancel resumed across the release counts each earlier joiner its ledger shows refunded, cancelled and not deleted", async () => {
    mocks.claimedFindUniqueOrThrow.mockResolvedValue(named("Ben", "Joiner"));
    mocks.ledgerFindMany.mockResolvedValue([{ bookingId: "child-a" }]);
    mocks.bookingFindMany.mockResolvedValue([{ id: "child-a", ...named("Ana", "Joiner") }]);

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    expect(mocks.ledgerFindMany).toHaveBeenCalledWith({
      where: { postingKey: { in: ["group-settlement:settle-1:refund:child-a"] } },
      select: { bookingId: true },
    });
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["child-a"] }, deletedAt: null, status: BookingStatus.CANCELLED } }),
    );
    expect(raised).toMatchObject({ amountCents: 7500, created: true });
    expect(raised?.reason).toContain("Ana Joiner $45.00, Ben Joiner $30.00");
  });

  it("books nothing for a joiner the plan owes nothing", async () => {
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-c" })).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("the hand-back's reason", () => {
  it("lists shares up to the column, then counts the rest, and a later share appends to the count", () => {
    const shares = Array.from({ length: 20 }, (_, index) => `Joiner Number ${index + 1} $${index + 10}.00`);
    const reason = composeGroupHandBackReason({ totalCents: 123_456, shares, more: 0, supplementary: false, format: CLUB_FORMAT_TEST });
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).toContain("Repay the organiser $1,234.56 by bank transfer.");
    expect(reason).toMatch(/ … and (\d+) more \(see each joiner's booking\)\.$/);
    const read = readGroupHandBackReasonShares(reason);
    expect(read.shares).toEqual(shares.slice(0, read.shares.length));
    expect(read.shares.length + read.more).toBe(20);

    const grown = composeGroupHandBackReason({ totalCents: 124_000, shares: [...read.shares, "One More $5.44"], more: read.more, supplementary: false, format: CLUB_FORMAT_TEST });
    const reread = readGroupHandBackReasonShares(grown);
    expect(reread.shares.length + reread.more).toBe(21);
  });

  it("reads back what it wrote when everything fits", () => {
    const reason = composeGroupHandBackReason({ totalCents: 7500, shares: ["Ana Joiner $45.00", "Ben Joiner $30.00"], more: 0, supplementary: false, format: CLUB_FORMAT_TEST });
    expect(readGroupHandBackReasonShares(reason)).toEqual({ shares: ["Ana Joiner $45.00", "Ben Joiner $30.00"], more: 0 });
  });
});

describe("the hand-back's marker", () => {
  it("is its own prefix: a cancellation's hand-back, never an edit's or an appeal's", () => {
    const task = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: groupOrganiserHandBackOccurrenceKey("s") };
    expect(isGroupOrganiserHandBackTask(task)).toBe(true);
    expect(isNonCancellationHandBackTask(task)).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: task.occurrenceKey })).toBe(false);
    // The query fragment the cancellation readers spread keeps it (a NOT on the two other prefixes).
    expect(JSON.stringify(NOT_NON_CANCELLATION_HAND_BACK_WHERE)).not.toContain("group-organiser-hand-back:");
  });
});

describe("alertGroupOrganiserHandBack", () => {
  const TASK = { id: "task-1", amountCents: 7500, reason: "Group cancelled by its organiser - paid by Internet Banking.", created: true };

  it("sends the Manual refund needed alert in its group wording, naming the organiser and their stay", async () => {
    mocks.organiserFindUniqueOrThrow.mockResolvedValue({
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      member: { firstName: "Olive", lastName: "Organiser" },
      organisation: null,
    });

    await alertGroupOrganiserHandBack({ organiserBookingId: "org-booking", task: TASK, format: CLUB_FORMAT_TEST });

    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledWith(
      {
        memberName: "Olive Organiser",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        refundAmountCents: 7500,
        bookingId: "org-booking",
        reason: TASK.reason,
        situation: "group-organiser-internet-banking",
      },
      CLUB_FORMAT_TEST,
    );
  });

  it("never throws: the cancellation has committed, and the task is the record", async () => {
    mocks.organiserFindUniqueOrThrow.mockRejectedValue(new Error("db down"));

    await expect(alertGroupOrganiserHandBack({ organiserBookingId: "org-booking", task: TASK, format: CLUB_FORMAT_TEST })).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe("the finance queue payload marks it for the card's own sentence", () => {
  it("true for the group key only", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "org-booking",
      amountCents: 7500,
      raisedAmountCents: 7500,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      paymentId: null,
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: groupOrganiserHandBackOccurrenceKey("settle-1"),
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Olive", lastName: "Organiser" },
        organisation: null,
        memberId: "olive",
        deletedAt: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const payload = toOpenManualRefundTaskPayload(row, null, []);
    expect(payload).toMatchObject({ groupOrganiserHandBack: true, editRefundHandBack: false, refundRequestHandBack: false, memberName: "Olive Organiser" });
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).groupOrganiserHandBack).toBe(false);
  });
});
