// #4104 (`INV-PAY-128`): a card refund Stripe accepted and failed later is owed
// again. These are the rules of `keepFailedLaterCardRefundOwed` against a fake
// transaction: whose refund it is, which row owes it, the retry's generation,
// and the one alert after commit. The real-database proof is
// `card-refund-failed-later.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));

import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import {
  alertFailedLaterCardRefunds,
  FailedLaterRefundHeldError,
  keepFailedLaterCardRefundOwed,
  keepFailedLaterCardRefundsOwed,
} from "@/lib/card-refund-failed-later";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { bookingModificationRefundReasonForKeyPrefix } from "@/lib/payment-recovery-keys";

type Row = { id: string; status: string; allocationPlan: unknown; bookingId: string; paymentIntentId: string };

function fakeTx({
  bookingId = "booking-1",
  open = [] as Row[],
  inserted = 1,
  moved = 1,
  transactionIntent = "pi_txn" as string | null,
} = {}) {
  const tx = {
    payment: { findUnique: vi.fn(async () => (bookingId === null ? null : { bookingId })) },
    paymentTransaction: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: transactionIntent })) },
    paymentRecoveryOperation: {
      findMany: vi.fn(async () => open),
      createMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: inserted })),
      updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: moved })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "op-new" })),
    },
  };
  return tx;
}

const keep = (tx: ReturnType<typeof fakeTx>, refund: Parameters<typeof keepFailedLaterCardRefundOwed>[1]["refund"], paymentIntentId: string | null = "pi_1") =>
  keepFailedLaterCardRefundOwed(tx as never, { paymentId: "pay-1", paymentTransactionId: "txn-1", refund, paymentIntentId });

const CANCEL_REFUND = { id: "re_1", amount: 4_000, status: "failed", metadata: { bookingId: "booking-1", reason: "cancellation" } };

beforeEach(() => alertPaymentRecoveryOfficers.mockClear());

describe("whose refund is owed again", () => {
  it.each([
    ["the cancellation's", { bookingId: "booking-1", reason: "cancellation" }],
    ["an edit's", { bookingId: "booking-1", reason: "date_change_price_decrease" }],
    ["an approved refund request's", { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" }],
    ["the runner's", { bookingId: "booking-1", reason: "booking_modification_refund_recovery" }],
  ])("%s refund, made for this booking, raises one row for exactly that refund", async (_door, metadata) => {
    const tx = fakeTx();
    const debt = await keep(tx, { ...CANCEL_REFUND, metadata });
    expect(debt).toEqual({
      outcome: "raised",
      operationId: "op-new",
      bookingId: "booking-1",
      paymentIntentId: "pi_1",
      amountCents: 4_000,
      stripeRefundId: "re_1",
    });
    const [[{ data }]] = tx.paymentRecoveryOperation.createMany.mock.calls as unknown as [[{ data: Array<Record<string, unknown>> }]];
    expect(data[0]).toMatchObject({
      type: "REFUND_BOOKING_MODIFICATION",
      status: "PENDING",
      bookingId: "booking-1",
      paymentId: "pay-1",
      paymentIntentId: "pi_1",
      amountCents: 4_000,
      idempotencyKey: "card_refund_failed_later_re_1",
      // Its own key is the Stripe prefix: a request Stripe has never seen.
      stripeKeyPrefix: "card_refund_failed_later_re_1",
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
      attempts: 0,
    });
    expect(tx.paymentRecoveryOperation.createMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true });
  });

  it.each([
    ["names no booking (a refund made by hand in the Stripe dashboard)", null],
    ["names another booking", { bookingId: "booking-2", reason: "cancellation" }],
  ])("one that %s is not the club's to re-send", async (_case, metadata) => {
    const tx = fakeTx();
    expect(await keep(tx, { ...CANCEL_REFUND, metadata })).toBeNull();
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });

  it("a second writer seeing the same refund writes nothing more", async () => {
    const tx = fakeTx({ inserted: 0 });
    expect(await keep(tx, CANCEL_REFUND)).toBeNull();
  });

  it("takes the charge's own intent when the refund names none", async () => {
    const tx = fakeTx({ transactionIntent: "pi_txn" });
    expect(await keep(tx, CANCEL_REFUND, null)).toMatchObject({ paymentIntentId: "pi_txn" });
  });

  it("raises nothing for a charge with no card intent", async () => {
    const tx = fakeTx({ transactionIntent: null });
    expect(await keep(tx, CANCEL_REFUND, null)).toBeNull();
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });
});

describe("each refund the ledger writer saw fail later", () => {
  it("is kept owed in turn, on the intent the refund names or else the writer's", async () => {
    const tx = fakeTx();
    const debts = await keepFailedLaterCardRefundsOwed(tx as never, {
      paymentId: "pay-1",
      paymentTransactionId: "txn-1",
      refunds: [
        { ...CANCEL_REFUND, payment_intent: "pi_named" },
        { ...CANCEL_REFUND, id: "re_2", payment_intent: null },
        { ...CANCEL_REFUND, id: "re_3", metadata: null },
      ],
      fallbackPaymentIntentId: "pi_fallback",
    });
    expect(debts.map((debt) => [debt.stripeRefundId, debt.paymentIntentId])).toEqual([
      ["re_1", "pi_named"],
      ["re_2", "pi_fallback"],
    ]);
  });
});

describe("a retry that fails later too", () => {
  it("is raised dead - attempts spent, never claimed - for Paid another way", async () => {
    const tx = fakeTx();
    const retry = {
      ...CANCEL_REFUND,
      id: "re_retry",
      metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_1") },
    };
    expect(await keep(tx, retry)).toMatchObject({ outcome: "raised-dead" });
    const [[{ data }]] = tx.paymentRecoveryOperation.createMany.mock.calls as unknown as [[{ data: Array<Record<string, unknown>> }]];
    expect(data[0]).toMatchObject({ idempotencyKey: "card_refund_failed_later_re_retry", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    // Stripe sent nothing: the dead row carries no "Stripe may have refunded" warning.
    expect(lastErrorSuggestsStripeMayHaveRefunded(String(data[0]?.lastError))).toBe(false);
  });

  it("the retry's Stripe reason is the one the generation is read from", () => {
    expect(bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_1")).toBe("card_refund_failed_later");
  });
});

describe("a refund an open row marked made beside a refusal (#4083)", () => {
  const plan = [
    { paymentTransactionId: "txn-1", amountCents: 4_000, madeRefundId: "re_1" },
    { paymentTransactionId: "txn-2", amountCents: 1_000, stripeKeySuffix: "refused1" },
  ];
  const openRow = (status: string): Row => ({ id: "op-open", status, allocationPlan: plan, bookingId: "booking-1", paymentIntentId: "pi_open" });

  it("re-plans that row - the slice unmarked, on its next key - and raises no second row", async () => {
    const tx = fakeTx({ open: [openRow("FAILED")] });
    expect(await keep(tx, CANCEL_REFUND)).toMatchObject({ outcome: "re-planned", operationId: "op-open", amountCents: 4_000 });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    const [[{ where, data }]] = tx.paymentRecoveryOperation.updateMany.mock.calls as unknown as [[{ where: Record<string, unknown>; data: Record<string, unknown> }]];
    // Compare-and-set on the plan it read.
    expect(where).toEqual({ id: "op-open", status: "FAILED", allocationPlan: { equals: plan } });
    expect(data.allocationPlan).toEqual([
      { paymentTransactionId: "txn-1", amountCents: 4_000, stripeKeySuffix: "refused1" },
      plan[1],
    ]);
  });

  it("never touches a row a worker holds: the caller fails and is retried", async () => {
    const tx = fakeTx({ open: [openRow("PROCESSING")] });
    await expect(keep(tx, CANCEL_REFUND)).rejects.toBeInstanceOf(FailedLaterRefundHeldError);
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("a plan that moved since it was read is not overwritten", async () => {
    const tx = fakeTx({ open: [openRow("PENDING")], moved: 0 });
    await expect(keep(tx, CANCEL_REFUND)).rejects.toBeInstanceOf(FailedLaterRefundHeldError);
  });

  it("an open row that never marked this refund is not its owner", async () => {
    const tx = fakeTx({ open: [{ ...openRow("PENDING"), allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }] }] });
    expect(await keep(tx, CANCEL_REFUND)).toMatchObject({ outcome: "raised" });
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });
});

describe("the officers' alert", () => {
  const debt = { operationId: "op-1", bookingId: "booking-1", paymentIntentId: "pi_1", amountCents: 4_000, stripeRefundId: "re_1" };

  it("is sent once per row raised, naming the amount", async () => {
    await alertFailedLaterCardRefunds([{ ...debt, outcome: "raised" }]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(alertPaymentRecoveryOfficers.mock.calls[0]).toMatchObject([
      { bookingId: "booking-1", operationId: "op-1", amountCents: 4_000, errorMessage: expect.stringContaining("$40.00") },
      expect.anything(),
    ]);
    expect((alertPaymentRecoveryOfficers.mock.calls[0] as unknown as [{ errorMessage: string }])[0].errorMessage).toMatch(/will be asked for again automatically/);
  });

  it("says a dead one will not be asked for again", async () => {
    await alertFailedLaterCardRefunds([{ ...debt, outcome: "raised-dead" }]);
    expect((alertPaymentRecoveryOfficers.mock.calls[0] as unknown as [{ errorMessage: string }])[0].errorMessage).toMatch(/will not be asked for again automatically/);
  });

  it("sends nothing for nothing, and never throws", async () => {
    await alertFailedLaterCardRefunds([]);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
    alertPaymentRecoveryOfficers.mockRejectedValueOnce(new Error("mail down"));
    await expect(alertFailedLaterCardRefunds([{ ...debt, outcome: "raised" }])).resolves.toBeUndefined();
  });
});
