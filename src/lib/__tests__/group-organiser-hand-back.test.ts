import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, ManualRefundTaskKind } from "@prisma/client";

/**
 * #4042 (`INV-PAY-120`): the one hand-back an organiser's Internet Banking group
 * cancel raises for the organiser, and its alert. Where the cancel calls these
 * is `group-cancel.test.ts`; the row against the real schema, its one-per-
 * settlement key and a completion that moves nothing are
 * `booking-ledger-group-settlement.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  create: vi.fn(),
  organiserFindUniqueOrThrow: vi.fn(),
  sendAdminManualRefundTaskAlert: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUniqueOrThrow: mocks.organiserFindUniqueOrThrow } },
}));
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: mocks.sendAdminManualRefundTaskAlert }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import { alertGroupOrganiserHandBack, raiseGroupOrganiserHandBackTask } from "@/lib/group-organiser-hand-back";
import {
  groupOrganiserHandBackOccurrenceKey,
  isGroupOrganiserHandBackTask,
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  manualRefundTask: { findUnique: mocks.findUnique, create: mocks.create },
  booking: { findMany: mocks.bookingFindMany },
} as unknown as Parameters<typeof raiseGroupOrganiserHandBackTask>[0];

const INPUT = {
  settlementId: "settle-1",
  organiserBookingId: "org-booking",
  plan: new Map([["child-a", 4500], ["child-b", 3000], ["child-c", 0]]),
  claimedChildId: "child-a",
  format: CLUB_FORMAT_TEST,
};

const joiner = (id: string, firstName: string, lastName: string) => ({ id, member: { firstName, lastName }, organisation: null });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(null);
  mocks.bookingFindMany.mockResolvedValue([joiner("child-a", "Ana", "Joiner"), joiner("child-b", "Ben", "Joiner")]);
  mocks.create.mockImplementation(async ({ data }: { data: { reason: string } }) => ({ id: "task-1", reason: data.reason }));
  mocks.sendAdminManualRefundTaskAlert.mockResolvedValue(undefined);
});

describe("raiseGroupOrganiserHandBackTask", () => {
  it("raises ONE cancellation hand-back on the organiser's booking, for the plan's total, with no payment and each joiner's share", async () => {
    const raised = await raiseGroupOrganiserHandBackTask(tx, INPUT);

    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { occurrenceKey: "group-organiser-hand-back:settle-1" },
      select: { id: true },
    });
    // Only planned children owed something; this claim's child, or one still active.
    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["child-a", "child-b"] },
          OR: [
            { id: "child-a" },
            { status: { in: [BookingStatus.PAYMENT_PENDING, BookingStatus.CONFIRMED, BookingStatus.PAID] } },
          ],
        },
      }),
    );
    const [{ data }] = mocks.create.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(data).toEqual({
      bookingId: "org-booking",
      amountCents: 7500,
      raisedAmountCents: 7500,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: "group-organiser-hand-back:settle-1",
      reason: expect.stringContaining("Repay the organiser $75.00 by bank transfer"),
    });
    // No paymentId: the joiners' refunds are already on their own payments, so
    // completing it takes no settlement route and moves nothing twice.
    expect(data).not.toHaveProperty("paymentId");
    expect(data.reason).toContain("Ana Joiner $45.00, Ben Joiner $30.00");
    expect(raised).toEqual({ id: "task-1", amountCents: 7500, reason: data.reason });
  });

  it("raises nothing when the settlement's hand-back already exists - a later child's claim or a re-drive", async () => {
    mocks.findUnique.mockResolvedValue({ id: "task-1" });

    expect(await raiseGroupOrganiserHandBackTask(tx, INPUT)).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("leaves out a planned joiner already gone some other way, whose refund this cancel does not record", async () => {
    mocks.bookingFindMany.mockResolvedValue([joiner("child-a", "Ana", "Joiner")]);

    expect(await raiseGroupOrganiserHandBackTask(tx, INPUT)).toMatchObject({ amountCents: 4500 });
  });

  it("raises nothing when nothing is owed", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);

    expect(await raiseGroupOrganiserHandBackTask(tx, INPUT)).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps the reason inside the column however many joiners there are", async () => {
    const many = Array.from({ length: 40 }, (_, index) => joiner(`child-${index}`, "Joiner", `Number ${index}`));
    mocks.bookingFindMany.mockResolvedValue(many);
    const plan = new Map(many.map((row) => [row.id, 1000]));

    await raiseGroupOrganiserHandBackTask(tx, { ...INPUT, plan, claimedChildId: "child-0" });

    const [{ data }] = mocks.create.mock.calls[0] as [{ data: { reason: string; amountCents: number } }];
    expect(data.reason.length).toBeLessThanOrEqual(500);
    expect(data.amountCents).toBe(40_000);
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
  const TASK = { id: "task-1", amountCents: 7500, reason: "Group cancelled by its organiser - paid by Internet Banking." };

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
