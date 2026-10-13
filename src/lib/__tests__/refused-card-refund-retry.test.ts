// #4083 (`INV-PAY-127`): a card refund Stripe refused is still owed, and its
// retry asks under a key Stripe has never seen. These are the pure rules: the
// key spelling and its generations, which statuses are refusals, which plan
// slices move, and that a persisted plan keeps the generation it was moved to.
import { describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn(async () => ({ count: 1 })));
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany } } }));

import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import {
  isRefusedRefundKeySuffix,
  nextRefusedRefundKeySuffix,
  refundSliceStripeIdempotencyKey,
} from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import { planAfterRefusals, refundPlanOrRetryRefusals, refusedRefundCents, refusedRefundSlices } from "@/lib/refused-card-refund-retry";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

describe("a refund slice's Stripe key and its generations", () => {
  it("generation 0 is the spelling every slice has always been sent under", () => {
    expect(refundSliceStripeIdempotencyKey("booking_cancel_refund_b1", { paymentTransactionId: "txn_1", amountCents: 2500 })).toBe(
      "booking_cancel_refund_b1_txn_1_2500",
    );
  });

  it("a moved slice carries its generation at the end of the key", () => {
    expect(
      refundSliceStripeIdempotencyKey("mod_dates_refund_b1_m1", { paymentTransactionId: "txn_1", amountCents: 2500, stripeKeySuffix: "refused3" }),
    ).toBe("mod_dates_refund_b1_m1_txn_1_2500_refused3");
  });

  it.each([
    [undefined, "refused1"],
    ["refused1", "refused2"],
    ["refused9", "refused10"],
    ["refused41", "refused42"],
  ])("moves %s on to %s, a key never sent before", (current, next) => {
    expect(nextRefusedRefundKeySuffix(current)).toBe(next);
  });

  it.each([
    ["refused1", true],
    ["refused12", true],
    ["refused0", false],
    ["refused", false],
    ["refused01", false],
    ["Refused1", false],
    ["retry1", false],
    [1, false],
    [null, false],
  ])("%s is a generation: %s", (value, valid) => {
    expect(isRefusedRefundKeySuffix(value)).toBe(valid);
  });
});

describe("what Stripe refused", () => {
  it.each([
    ["failed", true],
    ["canceled", true],
    ["pending", false],
    ["succeeded", false],
    ["requires_action", false],
    [null, false],
    [undefined, false],
  ])("a refund answered %s is refused: %s", (status, refused) => {
    expect(isRefusedRefundStatus(status)).toBe(refused);
  });

  it("names exactly the refused slices, as sent, and sums them in integer cents", () => {
    const made = { paymentTransactionId: "txn_2", amountCents: 600 };
    const failed = { paymentTransactionId: "txn_1", amountCents: 333, stripeKeySuffix: "refused1" };
    const canceled = { paymentTransactionId: "txn_0", amountCents: 67 };
    const refused = refusedRefundSlices([
      { status: "succeeded", slice: made },
      { status: "failed", slice: failed },
      { status: "canceled", slice: canceled },
      { status: null, slice: made },
    ]);

    expect(refused).toEqual([failed, canceled]);
    expect(refusedRefundCents(refused)).toBe(400);
  });
});

describe("the plan after a refusal", () => {
  const a = { paymentTransactionId: "txn_a", amountCents: 1000 };
  const b = { paymentTransactionId: "txn_b", amountCents: 500 };

  it("moves only the refused slice; the made one keeps its key, so a replay is answered, never made twice", () => {
    expect(planAfterRefusals([a, b], [b])).toEqual([a, { ...b, stripeKeySuffix: "refused1" }]);
  });

  it("matches a slice by its whole key: the same transaction and amount under another generation is a different request", () => {
    const moved = { ...b, stripeKeySuffix: "refused1" };
    expect(planAfterRefusals([moved], [b])).toEqual([moved]);
    expect(planAfterRefusals([moved], [moved])).toEqual([{ ...b, stripeKeySuffix: "refused2" }]);
  });
});

describe("a persisted plan keeps its generation", () => {
  it("parses a moved slice with its suffix, and a plain one without the key", () => {
    expect(
      parseRefundAllocationPlan([
        { paymentTransactionId: "txn_a", amountCents: 1000 },
        { paymentTransactionId: "txn_b", amountCents: 500, stripeKeySuffix: "refused2" },
      ]),
    ).toEqual([
      { paymentTransactionId: "txn_a", amountCents: 1000 },
      { paymentTransactionId: "txn_b", amountCents: 500, stripeKeySuffix: "refused2" },
    ]);
    expect(parseRefundAllocationPlan([{ paymentTransactionId: "txn_a", amountCents: 1000 }])?.[0]).not.toHaveProperty("stripeKeySuffix");
  });

  it.each([["refused0"], ["anything"], [7]])("refuses a malformed generation %s as a malformed plan", (suffix) => {
    expect(parseRefundAllocationPlan([{ paymentTransactionId: "txn_a", amountCents: 1000, stripeKeySuffix: suffix }])).toBeNull();
  });
});

describe("the attempt's failure", () => {
  it("names the refused amount and reads as a definite refusal on the stuck list, never as 'Stripe may have refunded'", async () => {
    const slice = { paymentTransactionId: "txn_a", amountCents: 50_000 };
    const failure = (await refundPlanOrRetryRefusals({
      operation: { id: "op_1", bookingId: "b1", paymentIntentId: "pi_1", processingStartedAt: new Date("2026-06-20T00:00:00.000Z") },
      plan: [slice],
      format: CLUB_FORMAT_TEST,
      refund: async () => ({ refunds: [{ status: "failed", slice }] }),
    }).catch((error: unknown) => error)) as Error;

    expect(failure.message).toMatch(/Stripe refused \$500\.00 .*still owed/);
    expect(lastErrorSuggestsStripeMayHaveRefunded(failure.message)).toBe(false);
  });
});
