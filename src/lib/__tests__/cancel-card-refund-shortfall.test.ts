/**
 * #4097 (`INV-PAY-129`): an own-card cancel's card refund shortfall is ONE
 * cancellation hand-back, keyed per booking, counted as owed while OPEN, and
 * marked for the money-to-settle card.
 *
 * MUTATION PROOF. Put the key prefix in the non-cancellation list and "a
 * cancellation's own hand-back" fails (its completion would then queue no
 * cancellation note and take lock(1)); raise on a covered plan and "nothing
 * owed" fails; drop the payload flag and the queue's sentence test fails.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { raiseCancelCardShortfallHandBack } from "@/lib/cancel-card-refund-shortfall";
import {
  cancelCardShortfallOccurrenceKey,
  isCancelCardShortfallTask,
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
  openHandBackOwedCents,
} from "@/lib/manual-refund-task-settlement-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const KEY = "cancel-card-shortfall:booking-1";

function tx(found: { id: string; amountCents: number | null } | null = { id: "task-1", amountCents: 4_000 }) {
  return {
    manualRefundTask: {
      createMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => found),
    },
  };
}

describe("raising a cancel's card refund shortfall (#4097)", () => {
  it("raises one CANCELLED_BOOKING_HAND_BACK for the difference, keyed on the booking, ON CONFLICT DO NOTHING", async () => {
    const store = tx();
    const raised = await raiseCancelCardShortfallHandBack(store as never, {
      bookingId: "booking-1",
      paymentId: "payment-1",
      refundAmountCents: 10_000,
      plannedCardRefundCents: 6_000,
      format: CLUB_FORMAT_TEST,
    });

    expect(raised).toEqual({ taskId: "task-1", shortfallCents: 4_000 });
    expect(store.manualRefundTask.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-1",
          paymentId: "payment-1",
          amountCents: 4_000,
          raisedAmountCents: 4_000,
          kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: KEY,
          reason:
            "Booking booking-1 cancelled - its card refund could carry only $60.00 of the $100.00 refund due, so the club refunds the remaining $40.00 by bank transfer. Dismiss with a note if it was refunded another way (#4097).",
        },
      ],
      skipDuplicates: true,
    });
    expect(store.manualRefundTask.findUnique).toHaveBeenCalledWith({ where: { occurrenceKey: KEY }, select: { id: true, amountCents: true } });
  });

  it("a zero plan raises the whole refund", async () => {
    const store = tx({ id: "task-1", amountCents: 10_000 });
    const raised = await raiseCancelCardShortfallHandBack(store as never, {
      bookingId: "booking-1", paymentId: "payment-1", refundAmountCents: 10_000, plannedCardRefundCents: 0, format: CLUB_FORMAT_TEST,
    });
    expect(raised).toEqual({ taskId: "task-1", shortfallCents: 10_000 });
    expect(store.manualRefundTask.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ amountCents: 10_000, raisedAmountCents: 10_000 })] }),
    );
  });

  it.each([
    ["the plan carries it all", 10_000],
    ["the plan carries more than is due", 12_000],
  ])("nothing owed when %s: no task", async (_label, planned) => {
    const store = tx();
    const raised = await raiseCancelCardShortfallHandBack(store as never, {
      bookingId: "booking-1", paymentId: "payment-1", refundAmountCents: 10_000, plannedCardRefundCents: planned, format: CLUB_FORMAT_TEST,
    });
    expect(raised).toBeNull();
    expect(store.manualRefundTask.createMany).not.toHaveBeenCalled();
  });

  it("a replay finds the task already there and answers it, at its own amount", async () => {
    const store = tx({ id: "task-first", amountCents: 3_000 });
    store.manualRefundTask.createMany.mockResolvedValueOnce({ count: 0 });
    const raised = await raiseCancelCardShortfallHandBack(store as never, {
      bookingId: "booking-1", paymentId: "payment-1", refundAmountCents: 10_000, plannedCardRefundCents: 6_000, format: CLUB_FORMAT_TEST,
    });
    expect(raised).toEqual({ taskId: "task-first", shortfallCents: 3_000 });
  });

  it("refuses, rolling the claim back, when the row cannot be read back", async () => {
    await expect(
      raiseCancelCardShortfallHandBack(tx(null) as never, {
        bookingId: "booking-1", paymentId: "payment-1", refundAmountCents: 10_000, plannedCardRefundCents: 6_000, format: CLUB_FORMAT_TEST,
      }),
    ).rejects.toThrow(/was not written/);
  });
});

describe("the shortfall task is a cancellation's own hand-back (#4097)", () => {
  const task = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: cancelCardShortfallOccurrenceKey("booking-1") } as const;

  it("is marked by its kind and key, and by nothing else", () => {
    expect(task.occurrenceKey).toBe(KEY);
    expect(isCancelCardShortfallTask(task)).toBe(true);
    expect(isCancelCardShortfallTask({ ...task, occurrenceKey: null })).toBe(false);
    expect(isCancelCardShortfallTask({ ...task, occurrenceKey: "refund-request-hand-back:r" })).toBe(false);
    expect(isCancelCardShortfallTask({ ...task, kind: "EDIT_FINANCIAL_REVIEW" })).toBe(false);
  });

  it("is never a non-cancellation hand-back: the readers of a cancellation's hand-backs keep it", () => {
    expect(isNonCancellationHandBackTask(task)).toBe(false);
    const excluded = NOT_NON_CANCELLATION_HAND_BACK_WHERE.OR[1]!.AND!.map((clause) => clause.NOT.occurrenceKey.startsWith);
    expect(excluded.some((prefix) => KEY.startsWith(prefix))).toBe(false);
  });

  it("counts as owed while OPEN, and not once closed", () => {
    const row = { ...task, amountCents: 4_000, partPaymentReviewPaymentId: null };
    expect(openHandBackOwedCents([{ ...row, status: "OPEN" }])).toBe(4_000);
    expect(openHandBackOwedCents([{ ...row, status: "COMPLETED" }, { ...row, status: "DISMISSED" }])).toBe(0);
  });

  it("is marked for the money-to-settle card", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "booking-1",
      amountCents: 4_000,
      raisedAmountCents: 4_000,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      paymentId: "payment-1",
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: KEY,
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Ann", lastName: "Owner" },
        organisation: null,
        memberId: "ann",
        deletedAt: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const payload = toOpenManualRefundTaskPayload(row as never, null, []);
    expect(payload.cardShortfallHandBack).toBe(true);
    expect(payload.refundRequestHandBack).toBe(false);
    expect(payload.editRefundHandBack).toBe(false);
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null } as never, null, []).cardShortfallHandBack).toBe(false);
  });
});
