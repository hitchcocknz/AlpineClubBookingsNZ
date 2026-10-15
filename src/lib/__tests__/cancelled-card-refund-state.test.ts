import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentRecoveryOperationStatus } from "@prisma/client";

import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

/**
 * #4125: where a card cancel's refund stands when no REFUNDED event says it was
 * made - read from its recovery row (the member's cancel or the capacity race),
 * so the booking page never reads a dead refund as "on its way".
 */
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findClose: vi.fn(),
  tasks: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findMany: db.findMany, findUnique: db.findUnique },
    manualRefundTask: { findFirst: db.findClose, findMany: db.tasks },
  },
}));

import { readCancelledCardRefund, readCardShortfallTaskStatuses } from "@/lib/cancel-card-refund-shortfall-status";

const readCancelledCardRefundState = async (bookingId: string) => (await readCancelledCardRefund(bookingId)).cardRefundState;

type Row = { id: string; idempotencyKey: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };
const row = (overrides: Partial<Row> = {}): Row => ({
  id: "op-1",
  idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1_pi_1",
  status: PaymentRecoveryOperationStatus.PENDING,
  attempts: 0,
  nextRetryAt: new Date("2026-07-01T00:05:00.000Z"),
  ...overrides,
});

describe("readCancelledCardRefund (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
  });

  it("reads the member's cancel row and this booking's capacity-race rows, in one query", async () => {
    db.findMany.mockResolvedValue([]);

    expect(await readCancelledCardRefundState("booking-1")).toBeUndefined();

    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        // On the bookingId index, never a scan of every row's key.
        bookingId: "booking-1",
        OR: [
          { idempotencyKey: "booking_cancel_refund_recovery_booking-1" },
          // The trailing underscore keeps booking-1's prefix from matching booking-10's rows.
          { idempotencyKey: { startsWith: "capacity\\_claim\\_failed\\_refund\\_recovery\\_booking-1\\_" } }, // #4146: escaped
        ],
      },
    }));
    expect(db.findClose).not.toHaveBeenCalled();
  });

  it.each([
    ["a row the runner will still send", row(), "on-its-way"],
    ["a FAILED row with a retry scheduled", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: 2 }), "on-its-way"],
    ["a row being worked", row({ status: PaymentRecoveryOperationStatus.PROCESSING, attempts: 1 }), "on-its-way"],
    ["a FAILED row with its retries spent", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }), "stalled"],
    ["a FAILED row with no retry scheduled", row({ status: PaymentRecoveryOperationStatus.FAILED, attempts: 1, nextRetryAt: null }), "stalled"],
    ["a PENDING row raised dead at the ceiling", row({ attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS }), "stalled"],
    ["a closed row", row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null }), "settled"],
  ] as const)("%s reads %s", async (_label, found, expected) => {
    db.findMany.mockResolvedValue([found]);

    expect(await readCancelledCardRefundState("booking-1")).toBe(expected);
  });

  it("a closed row with a 'Paid another way' record reads as paid another way, with what that record paid back (#4145)", async () => {
    db.findMany.mockResolvedValue([row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null })]);
    // Paid back in part: $50.00 of the $70.00 still owed.
    db.findClose.mockResolvedValue({ amountCents: 5_000 });

    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "paid-another-way", cardRefundPaidBackCents: 5_000 });
    expect(db.findClose).toHaveBeenCalledWith({
      where: { occurrenceKey: { in: expect.arrayContaining([expect.stringContaining("op-1")]) } },
      select: { amountCents: true },
    });
  });

  it("#4145: a capacity race's rows paid another way read as what they paid back together; a row not paid another way carries no figure", async () => {
    const closed = (id: string) => row({ id, idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}`, status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null });
    db.findMany.mockResolvedValue([closed("a"), closed("b")]);
    db.findClose.mockResolvedValueOnce({ amountCents: 2_000 }).mockResolvedValueOnce({ amountCents: 3_000 });
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "paid-another-way", cardRefundPaidBackCents: 5_000 });

    db.findMany.mockResolvedValue([closed("a")]);
    db.findClose.mockResolvedValue(null);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "settled" });
  });

  // SQL LIKE reads `_` as any one character, so the database can hand back a
  // row of booking `booking-1x`'s for booking-1's prefix; it is not this booking's.
  it("ignores a row the LIKE wildcard matched that is not this booking's, and reads the member's cancel row", async () => {
    db.findMany.mockResolvedValue([
      row({ id: "op-other", idempotencyKey: "capacity_claim_failed_refund_recovery_booking-1x_pi_1", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }),
      row({ id: "op-own", idempotencyKey: "booking_cancel_refund_recovery_booking-1" }),
    ]);

    expect(await readCancelledCardRefundState("booking-1")).toBe("on-its-way");
  });

  it("several rows read as the one furthest from done", async () => {
    const closed = row({ id: "op-closed", status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null });
    const live = row({ id: "op-live" });
    const dead = row({ id: "op-dead", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });

    db.findMany.mockResolvedValue([closed, live]);
    expect(await readCancelledCardRefundState("booking-1")).toBe("on-its-way");

    db.findMany.mockResolvedValue([closed, live, dead]);
    expect(await readCancelledCardRefundState("booking-1")).toBe("stalled");
  });
});

// #4125: a card refund shortfall's card part reads its row the same way, so a
// dead one is stalled there too - never "on its way".
describe("readCardShortfallTaskStatuses reads a dead card part as stalled (#4125)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.findClose.mockResolvedValue(null);
    db.tasks.mockResolvedValue([{ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", status: "OPEN" }]);
  });

  it.each([
    ["dead", row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1", status: PaymentRecoveryOperationStatus.FAILED, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null }), "stalled"],
    ["still being sent", row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1" }), "on-its-way"],
  ] as const)("a %s card refund row", async (_label, found, card) => {
    db.findUnique.mockResolvedValue(found);

    expect(await readCardShortfallTaskStatuses("booking-1")).toEqual({ bank: "OPEN", card });
  });
});
