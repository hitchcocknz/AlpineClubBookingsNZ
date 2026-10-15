import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4154 (`INV-PAY-133`, owner decision 15 Oct 2026: "Guarded recalculation"):
 * a capacity race's card charge whose refunded total reads more than its refund
 * rows is corrected - lowered to them - before its hand-back is recorded, and
 * only when every condition holds. Each condition is shown blocking ALONE
 * against a baseline that corrects; the write is shown never to raise.
 *
 * The totals' writers are doubled (`compareAndSetRefundedAmount` is driven
 * through the function the correction hands it, so the never-raise rule is
 * the module's own); the real-database proof is
 * `capacity-race-refund-shortfall-task.realdb.test.ts`.
 */
const doubles = vi.hoisted(() => ({
  ledgerStart: vi.fn<() => Promise<number | null>>(),
  compareAndSet: vi.fn(),
  reconcile: vi.fn(async () => null),
  credit: vi.fn<() => Promise<number>>(),
  audit: vi.fn(async () => {}),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payment-transactions", () => ({
  refundLedgerStartSeconds: doubles.ledgerStart,
  compareAndSetRefundedAmount: doubles.compareAndSet,
  reconcilePaymentAggregates: doubles.reconcile,
}));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({ accountCreditDispositionCents: doubles.credit }));
vi.mock("@/lib/audit", () => ({ createAuditLog: doubles.audit }));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: class extends Error {
    constructor(message: string, readonly status = 400) {
      super(message);
    }
  },
}));

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  CAPACITY_RACE_CORRECTION_BLOCKED_REASON,
  capacityRaceChargeForHandBack,
  type CapacityRaceCorrectionBlocked,
} from "@/lib/capacity-race-refunded-total-correction";

const BASE = "Nothing left to refund on this charge.";
const at = (seconds: number) => new Date(seconds * 1000);
const LEDGER_START = 1_000;

type Charge = { id: string; amountCents: number; refundedAmountCents: number; createdAt: Date };
type Refund = { amountCents: number; status: string; stripeCreatedAt: Date | null };

/** The baseline: a $200 charge made after the ledger started, reading all of it refunded, with $140 of card refund on record. */
function world(over: { charges?: Charge[]; refunds?: Refund[]; otherTasks?: number } = {}) {
  const charges = over.charges ?? [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 20_000, createdAt: at(2_000) }];
  const refunds = over.refunds ?? [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt: at(3_000) }];
  return {
    paymentTransaction: { findMany: vi.fn(async () => charges) },
    manualRefundTask: { count: vi.fn(async () => over.otherTasks ?? 0) },
    paymentRefund: { findMany: vi.fn(async () => refunds) },
  };
}

const run = (store: ReturnType<typeof world>, amountCents = 6_000) =>
  capacityRaceChargeForHandBack(store as never, {
    task: { id: "task-race", bookingId: "booking-1", paymentId: "payment-1" },
    raceIntentId: "pi_race",
    amountCents,
    actingMemberId: "officer-1",
    nothingToAllocateMessage: BASE,
    format: CLUB_FORMAT_TEST,
  });

const expectBlocked = async (store: ReturnType<typeof world>, blocked: CapacityRaceCorrectionBlocked) => {
  await expect(run(store)).rejects.toMatchObject({
    status: 400,
    message: `${BASE} (The app could not correct the charge's records itself: ${CAPACITY_RACE_CORRECTION_BLOCKED_REASON[blocked]}.)`,
  });
  expect(doubles.compareAndSet).not.toHaveBeenCalled();
  expect(doubles.reconcile).not.toHaveBeenCalled();
  expect(doubles.audit).not.toHaveBeenCalled();
};

describe("a capacity race's charge corrected for its hand-back (#4154, INV-PAY-133)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.ledgerStart.mockResolvedValue(LEDGER_START);
    doubles.credit.mockResolvedValue(0);
    doubles.compareAndSet.mockImplementation(async (_db: unknown, _id: string, nextFrom: (row: { amountCents: number; refundedAmountCents: number }) => number) => {
      const row = { amountCents: 20_000, refundedAmountCents: 20_000 };
      return { previousCents: row.refundedAmountCents, nextCents: nextFrom(row) };
    });
  });

  it("CONTROL: every condition holding, lowers the charge to its refund rows, re-derives the payment, audits before and after, and hands back the charge", async () => {
    const store = world();

    await expect(run(store)).resolves.toEqual({ chargeId: "txn-race" });

    expect(store.paymentTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ paymentId: "payment-1", stripePaymentIntentId: "pi_race" }) }));
    expect(doubles.compareAndSet).toHaveBeenCalledWith(store, "txn-race", expect.any(Function), { writeStatus: true });
    expect(doubles.reconcile).toHaveBeenCalledWith({ paymentId: "payment-1", store });
    expect(doubles.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.capacity-race.refunded-total-corrected",
        summary: expect.stringContaining("corrected from $200.00 to $140.00"),
        actorMemberId: "officer-1",
        category: "payment",
        entityId: "txn-race",
        metadata: expect.objectContaining({ refundedBeforeCents: 20_000, refundedAfterCents: 14_000, manualRefundTaskId: "task-race" }),
      }),
      store,
    );
  });

  it("a charge that already holds the task is not touched", async () => {
    const store = world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 14_000, createdAt: at(2_000) }] });
    await expect(run(store)).resolves.toEqual({ chargeId: "txn-race" });
    expect(doubles.ledgerStart).not.toHaveBeenCalled();
    expect(doubles.compareAndSet).not.toHaveBeenCalled();
  });

  it("MUTATION (never raise): the write takes the smaller of the row's total and the refund rows' - a row already below them stays", async () => {
    await run(world());
    const nextFrom = doubles.compareAndSet.mock.calls[0]![2] as (row: { amountCents: number; refundedAmountCents: number }) => number;
    expect(nextFrom({ amountCents: 20_000, refundedAmountCents: 20_000 })).toBe(14_000);
    expect(nextFrom({ amountCents: 20_000, refundedAmountCents: 9_000 })).toBe(9_000);
  });

  it("MUTATION: a row that moved under the write so the charge no longer holds the task is refused after all", async () => {
    doubles.compareAndSet.mockResolvedValue({ previousCents: 20_000, nextCents: 18_000 });
    await expect(run(world())).rejects.toMatchObject({ message: expect.stringContaining(CAPACITY_RACE_CORRECTION_BLOCKED_REASON["still-short"]) });
  });

  it("a refused or cancelled refund row is not a refund on record", async () => {
    const store = world({ refunds: [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt: at(3_000) }, { amountCents: 6_000, status: "failed", stripeCreatedAt: at(3_100) }] });
    await expect(run(store)).resolves.toEqual({ chargeId: "txn-race" });
    expect(doubles.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ recordedCardRefundCents: 14_000 }) }), store);
  });

  it("an install with no migration history never ran pre-ledger code: the date conditions hold", async () => {
    doubles.ledgerStart.mockResolvedValue(null);
    await expect(run(world())).resolves.toEqual({ chargeId: "txn-race" });
  });

  describe("each condition blocks alone", () => {
    it("MUTATION: no captured charge for the race's intent", async () => {
      await expectBlocked(world({ charges: [] }), "no-charge");
    });

    it("MUTATION: the charge made before the refund ledger started", async () => {
      await expectBlocked(world({ charges: [{ id: "txn-race", amountCents: 20_000, refundedAmountCents: 20_000, createdAt: at(LEDGER_START - 1) }] }), "charge-before-ledger");
    });

    it("MUTATION: account credit given back from the booking", async () => {
      doubles.credit.mockResolvedValue(1);
      await expectBlocked(world(), "account-credit");
    });

    it("MUTATION: another refund task on the booking or its payment", async () => {
      const store = world({ otherTasks: 1 });
      await expectBlocked(store, "other-task");
      expect(store.manualRefundTask.count).toHaveBeenCalledWith({
        where: { id: { not: "task-race" }, OR: [{ bookingId: "booking-1" }, { paymentId: "payment-1" }] },
      });
    });

    it.each([
      ["dated before the ledger started", at(LEDGER_START - 1)],
      ["undated", null],
    ])("MUTATION: a refund row on the charge %s", async (_label, stripeCreatedAt) => {
      await expectBlocked(world({ refunds: [{ amountCents: 14_000, status: "succeeded", stripeCreatedAt }] }), "pre-ledger-refund");
    });

    it("MUTATION (never raise): the refund rows already account for all the charge reads refunded", async () => {
      await expectBlocked(world({ refunds: [{ amountCents: 20_000, status: "succeeded", stripeCreatedAt: at(3_000) }] }), "nothing-to-lower");
    });

    it("MUTATION: even corrected, the charge would not hold the task", async () => {
      await expectBlocked(world({ refunds: [{ amountCents: 16_000, status: "succeeded", stripeCreatedAt: at(3_000) }] }), "still-short");
    });
  });
});
