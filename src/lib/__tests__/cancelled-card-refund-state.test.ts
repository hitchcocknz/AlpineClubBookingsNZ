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
  payments: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findMany: db.findMany, findUnique: db.findUnique },
    manualRefundTask: { findFirst: db.findClose, findMany: db.tasks },
    payment: { findMany: db.payments },
  },
}));

import { readCancelledCardRefund, readCardShortfallTaskStatuses } from "@/lib/cancel-card-refund-shortfall-status";

const readCancelledCardRefundState = async (bookingId: string) => (await readCancelledCardRefund(bookingId)).cardRefundState;

type Row = { id: string; idempotencyKey: string; paymentId: string; status: PaymentRecoveryOperationStatus; attempts: number; nextRetryAt: Date | null };
const row = (overrides: Partial<Row> = {}): Row => ({
  id: "op-1",
  paymentId: "pay-1",
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

  /** The payment the closed rows hang on: `made` refunds recorded against op-1's first slice. */
  function paymentWith(made: number[], operations: Array<{ id: string; amountCents: number; plan: Array<{ paymentTransactionId: string; amountCents: number; madeRefundId?: string }> }>) {
    return {
      id: "pay-1",
      status: "PARTIALLY_REFUNDED",
      amountCents: 20_000,
      refundedAmountCents: made.reduce((sum, cents) => sum + cents, 0),
      recoveryOperations: operations.map(({ id, amountCents, plan }) => ({
        id,
        type: "REFUND_BOOKING_MODIFICATION",
        status: "SUCCEEDED",
        idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}`,
        amountCents,
        allocationPlan: plan,
        paymentTransactionId: null,
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        succeededAt: new Date("2026-06-30T00:00:00.000Z"),
      })),
      refunds: made.map((cents, index) => ({
        stripeRefundId: `re_${index}`,
        paymentTransactionId: "txn-1",
        amountCents: cents,
        status: "succeeded",
        createdAt: new Date("2026-06-21T00:00:00.000Z"),
        stripeCreatedAt: new Date("2026-06-21T00:00:00.000Z"),
      })),
    };
  }

  it("a closed row with a 'Paid another way' record reads as paid another way, with what that record paid back and left unpaid, and what its slices took (#4145)", async () => {
    db.findMany.mockResolvedValue([row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null })]);
    // $100.00 due: $30.00 went back to the card; of the $70.00 still owed, $50.00 was paid back.
    db.findClose.mockResolvedValue({ amountCents: 5_000, raisedAmountCents: 7_000 });
    db.payments.mockResolvedValue([paymentWith([3_000], [{ id: "op-1", amountCents: 10_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 3_000, madeRefundId: "re_0" }, { paymentTransactionId: "txn-1", amountCents: 7_000 }] }])]);

    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 5_000, unpaidCents: 2_000, madeCents: 3_000 },
    });
    expect(db.findClose).toHaveBeenCalledWith({
      where: { occurrenceKey: { in: expect.arrayContaining([expect.stringContaining("op-1")]) } },
      select: { amountCents: true, raisedAmountCents: true },
    });
    expect(db.payments).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["pay-1"] } } }));
  });

  it("MUTATION #4145: a capped close's made part is what its refunds took, never the due less what the row still owed", async () => {
    // $90.00 due, nothing reached the card, and the payment held only $60.00: closed in full for that.
    db.findMany.mockResolvedValue([row({ status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null })]);
    db.findClose.mockResolvedValue({ amountCents: 6_000, raisedAmountCents: 6_000 });
    db.payments.mockResolvedValue([paymentWith([], [{ id: "op-1", amountCents: 9_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 9_000 }] }])]);

    expect((await readCancelledCardRefund("booking-1")).cardRefundClose).toEqual({ paidBackCents: 6_000, unpaidCents: 0, madeCents: 0 });
  });

  it("#4145: a capacity race's rows paid another way read as what they paid back, left unpaid and took together; a row not paid another way carries no figure", async () => {
    const closed = (id: string) => row({ id, idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}`, status: PaymentRecoveryOperationStatus.SUCCEEDED, nextRetryAt: null });
    db.findMany.mockResolvedValue([closed("a"), closed("b")]);
    db.findClose.mockResolvedValueOnce({ amountCents: 2_000, raisedAmountCents: 2_000 }).mockResolvedValueOnce({ amountCents: 3_000, raisedAmountCents: 4_000 });
    db.payments.mockResolvedValue([
      paymentWith([1_000], [
        { id: "a", amountCents: 3_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 1_000, madeRefundId: "re_0" }, { paymentTransactionId: "txn-1", amountCents: 2_000 }] },
        { id: "b", amountCents: 4_000, plan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }] },
      ]),
    ]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({
      cardRefundState: "paid-another-way",
      cardRefundClose: { paidBackCents: 5_000, unpaidCents: 1_000, madeCents: 1_000 },
    });

    db.findMany.mockResolvedValue([closed("a")]);
    db.findClose.mockResolvedValue(null);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "settled" });
  });

  it("MUTATION #4145: a capacity race's rows read with their frozen plans together, in every state; a member's cancel carries none", async () => {
    const raced = (id: string, extra: Record<string, unknown>) => ({ ...row({ id, idempotencyKey: `capacity_claim_failed_refund_recovery_booking-1_pi_${id}` }), ...extra });
    db.findMany.mockResolvedValue([
      raced("a", { amountCents: 9_000, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 6_000 }, { paymentTransactionId: "txn-2", amountCents: 3_000 }] }),
      // A row with no plan reads at its amount.
      raced("b", { amountCents: 2_000, allocationPlan: null }),
    ]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "on-its-way", cardRefundPlanCents: 11_000 });

    db.findMany.mockResolvedValue([{ ...row({ idempotencyKey: "booking_cancel_refund_recovery_booking-1" }), amountCents: 9_000, allocationPlan: null }]);
    expect(await readCancelledCardRefund("booking-1")).toEqual({ cardRefundState: "on-its-way" });
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
