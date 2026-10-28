import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const { list, record } = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/recorded-card-refund-notes", () => ({ queueRecordedCardRefundNotes: vi.fn().mockResolvedValue({ queueOperationId: null }) }));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: list }));
vi.mock("@/lib/payment-transactions", () => ({ recordStripeRefundsAgainstTransaction: record }));
import { queueRecordedCardRefundNotes } from "@/lib/recorded-card-refund-notes";
import { checkCardRefundResend, UnattributedCardRefundBeforeResendError } from "@/lib/card-refund-resend-preflight";

const arose = new Date("2026-06-30T12:00:00.750Z");
const args = {
  operation: { paymentId: "payment-test", bookingId: "booking-test", createdAt: arose },
  plan: [{ paymentTransactionId: "transaction-test", amountCents: 4000 }],
  transactions: [{ id: "transaction-test", stripePaymentIntentId: "pi_test", stripeChargeId: "ch_test" }],
};
function refund(overrides: Record<string, unknown> = {}): Stripe.Refund {
  return { id: "re_test", amount: 4000, currency: "nzd", status: "succeeded", charge: "ch_test", payment_intent: "pi_test", created: Math.floor(arose.getTime() / 1000), metadata: {}, ...overrides } as Stripe.Refund;
}
beforeEach(() => {
  list.mockReset().mockResolvedValue([]);
  record.mockReset().mockResolvedValue({ readAsRefused: [], appliedCents: 4000, newlyCountedRefundIds: ["re_test"], payment: { id: "payment-test", source: "STRIPE" } });
  vi.mocked(queueRecordedCardRefundNotes).mockReset().mockResolvedValue({ queueOperationId: null });
});

describe("card refund preflight", () => {
  it.each(["succeeded", "pending", "requires_action", null])("records a dashboard refund (%s) and holds even a partial amount at the boundary", async (status) => {
    const dashboard = refund({ status, amount: 1000 });
    list.mockResolvedValue([dashboard]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(list).toHaveBeenCalledExactlyOnceWith("pi_test", { timeoutMs: 10_000, singlePage: true });
    expect(record).toHaveBeenCalledExactlyOnceWith({
      paymentId: "payment-test", paymentTransactionId: "transaction-test", refunds: [dashboard],
      fallbackPaymentIntentId: "pi_test", fallbackChargeId: "ch_test",
    });
  });

  it.each([
    ["older dashboard refund", { created: Math.floor(arose.getTime() / 1000) - 1 }],
    ["app refund", { metadata: { bookingId: "booking-test", reason: "date_change_price_decrease" } }],
    ["failed refund", { status: "failed" }],
    ["canceled refund", { status: "canceled" }],
  ])("records but does not hold an %s", async (_name, overrides) => {
    list.mockResolvedValue([refund(overrides)]);
    await expect(checkCardRefundResend(args)).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated Stripe tags as evidence of an app refund", async () => {
    list.mockResolvedValue([refund({ metadata: { comment: "manual refund" } })]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("does not revive a failure from a stale counted provider response", async () => {
    list.mockResolvedValue([refund()]);
    record.mockResolvedValue({ readAsRefused: ["re_test"], payment: { id: "payment-test", source: "STRIPE" }, appliedCents: 0, newlyCountedRefundIds: [] });
    await expect(checkCardRefundResend(args)).resolves.toBeUndefined();
  });

  it.each([
    { charge: "ch_other" }, { payment_intent: "pi_other" },
  ])("ignores a refund on a different charge or intent: %j", async (overrides) => {
    list.mockResolvedValue([refund(overrides)]);
    await expect(checkCardRefundResend(args)).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it("accepts expanded Stripe references", async () => {
    list.mockResolvedValue([refund({ charge: { id: "ch_test" }, payment_intent: { id: "pi_test" } })]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("checks every unsent charge and never checks a marked slice", async () => {
    const multi = {
      ...args,
      plan: [...args.plan, { paymentTransactionId: "transaction-second", amountCents: 2000 }, { paymentTransactionId: "transaction-made", amountCents: 1000, madeRefundId: "re_made" }],
      transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second", stripeChargeId: "ch_second" }],
    };
    list.mockImplementation(async (intent) => intent === "pi_second" ? [refund({ charge: "ch_second", payment_intent: "pi_second" })] : []);
    await expect(checkCardRefundResend(multi)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(list).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ paymentTransactionId: "transaction-second" }));
  });

  it("propagates a provider failure before any write", async () => {
    list.mockRejectedValue(new Error("read timeout"));
    await expect(checkCardRefundResend(args)).rejects.toThrow("read timeout");
    expect(record).not.toHaveBeenCalled();
  });

  it("holds on conclusive evidence before a later charge can replace the hold with a retryable error", async () => {
    const multi = {
      ...args,
      plan: [...args.plan, { paymentTransactionId: "transaction-second", amountCents: 2000 }],
      transactions: [...args.transactions, { id: "transaction-second", stripePaymentIntentId: "pi_second", stripeChargeId: "ch_second" }],
    };
    list.mockImplementation(async (intent) => {
      if (intent === "pi_second") throw new Error("later charge timed out");
      return [refund()];
    });
    await expect(checkCardRefundResend(multi)).rejects.toMatchObject({
      constructor: UnattributedCardRefundBeforeResendError,
      stripeRefundIds: ["re_test"],
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(queueRecordedCardRefundNotes).toHaveBeenCalledTimes(1);
  });

  it("propagates a recording failure before a refund can be sent", async () => {
    list.mockResolvedValue([refund()]);
    record.mockRejectedValue(new Error("writer unavailable"));
    await expect(checkCardRefundResend(args)).rejects.toThrow("writer unavailable");
  });

  it("queues the existing accounting correction before holding the refund debt", async () => {
    list.mockResolvedValue([refund()]);
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
    expect(queueRecordedCardRefundNotes).toHaveBeenCalledExactlyOnceWith({
      payment: { id: "payment-test", source: "STRIPE" }, paymentIntentId: "pi_test",
      deltaCents: 4000, newlyCountedRefundIds: ["re_test"], refunds: [refund()],
    });
  });

  it("still holds the debt if its accounting note cannot be queued", async () => {
    list.mockResolvedValue([refund()]);
    vi.mocked(queueRecordedCardRefundNotes).mockRejectedValueOnce(new Error("note queue unavailable"));
    await expect(checkCardRefundResend(args)).rejects.toBeInstanceOf(UnattributedCardRefundBeforeResendError);
  });

  it("fails closed when a charge has no intent", async () => {
    await expect(checkCardRefundResend({ ...args, transactions: [{ ...args.transactions[0]!, stripePaymentIntentId: null }] })).rejects.toThrow("INV-PAY-145");
    expect(list).not.toHaveBeenCalled();
  });

  it("sends nothing if recording cannot reconcile the payment", async () => {
    list.mockResolvedValue([refund()]);
    record.mockResolvedValue({ readAsRefused: [], payment: null });
    await expect(checkCardRefundResend(args)).rejects.toThrow("could not reconcile the payment");
    expect(queueRecordedCardRefundNotes).not.toHaveBeenCalled();
  });

  it("fails closed if a planned charge is missing", async () => {
    await expect(checkCardRefundResend({ ...args, transactions: [] })).rejects.toThrow("INV-PAY-145");
    expect(list).not.toHaveBeenCalled();
  });
});
