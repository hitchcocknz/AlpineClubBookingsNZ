// #4083 (`INV-PAY-128`): a card refund Stripe refused is still owed, and its
// retry asks under a key Stripe has never seen. These are the pure rules: the
// key spelling and its generations, which statuses are refusals, which plan
// slices move, and that a persisted plan keeps the generation it was moved to.
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.hoisted(() => vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })));
const findUnique = vi.hoisted(() =>
  vi.fn<(args: unknown) => Promise<{ id: string; paymentIntentId: string; allocationPlan?: unknown }>>(async () => ({ id: "op_row", paymentIntentId: "pi_row" })),
);
vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany, findUnique } } }));
const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));

import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import {
  isRefusedRefundKeySuffix,
  nextRefusedRefundKeySuffix,
  refundSliceStripeIdempotencyKey,
} from "@/lib/payment-recovery-keys";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import { PartialRefundError } from "@/lib/payment-transactions";
import {
  firstRefusals,
  inlineRefundAfterAttempt,
  keepRefusedPrePersistedRefundOwed,
  keyAfterStripeRefusals,
  type RefundAttempt,
  sliceAfterRecordedRefusals,
  planAfterRefusals,
  refundPlanOrRetryRefusals,
  refusedRefundAlertMessage,
  refusedRefundCents,
  refusedRefundMessage,
  refusedRefundSlices,
} from "@/lib/refused-card-refund-retry";
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

// #4102, #4117: a door that raises its row AFTER the inline attempt (an
// approved refund request) queues the whole plan read: refused slices moved,
// made ones marked with their refund, unanswered ones on their own key.
describe("an inline attempt, read", () => {
  const a = { paymentTransactionId: "txn_a", amountCents: 1000 };
  const b = { paymentTransactionId: "txn_b", amountCents: 500 };
  const c = { paymentTransactionId: "txn_c", amountCents: 250 };
  const answer = (slice: typeof a, status: string) => ({
    status,
    slice,
    refundId: `re_${slice.paymentTransactionId}`,
    paymentIntentId: `pi_${slice.paymentTransactionId}`,
  });
  const partial = (refunds: ReturnType<typeof answer>[], refusedSlices: Array<typeof a>) =>
    new PartialRefundError({
      completedRefundCents: 0,
      refunds: refunds.map((each) => ({ ...each, amountCents: each.slice.amountCents })),
      refusedSlices,
      cause: new Error("boom"),
      format: CLUB_FORMAT_TEST,
    });

  it("every slice answered: refused ones on their next key, made ones marked; only the refused part is unmade", () => {
    expect(inlineRefundAfterAttempt([a, b, c], { refunds: [answer(a, "succeeded"), answer(b, "failed"), answer(c, "pending")] })).toEqual({
      plan: [{ ...a, madeRefundId: "re_txn_a" }, { ...b, stripeKeySuffix: "refused1" }, { ...c, madeRefundId: "re_txn_c" }],
      refused: [{ slice: b, paymentIntentId: "pi_txn_b" }],
      unmadeCents: 500,
      refusedCents: 500,
      unansweredCents: 0,
      reachedStripe: true,
    });
  });

  it("a refusal before a throw: it moves; the slice that threw and the one never sent keep their keys", () => {
    expect(inlineRefundAfterAttempt([a, b, c], { error: partial([answer(a, "canceled")], [a]) })).toEqual({
      plan: [{ ...a, stripeKeySuffix: "refused1" }, b, c],
      refused: [{ slice: a, paymentIntentId: "pi_txn_a" }],
      unmadeCents: 1750,
      // Certainly not made, and perhaps made at Stripe: told apart (#4117).
      refusedCents: 1000,
      unansweredCents: 750,
      reachedStripe: true,
    });
  });

  it("a made slice before a throw is marked, never asked for again", () => {
    expect(inlineRefundAfterAttempt([a, b, c], { error: partial([answer(a, "succeeded")], []) })).toMatchObject({
      plan: [{ ...a, madeRefundId: "re_txn_a" }, b, c],
      unmadeCents: 750,
      refusedCents: 0,
      unansweredCents: 750,
      reachedStripe: true,
    });
  });

  it("the first slice threw: Stripe was asked, so it was reached, though nothing came back", () => {
    expect(inlineRefundAfterAttempt([a, b], { error: partial([], []) })).toMatchObject({ plan: [a, b], unmadeCents: 1500, reachedStripe: true });
  });

  it("a throw before any Stripe call: the whole plan, as frozen, is unsent and Stripe was never reached", () => {
    const plan = [a, b];
    const read = inlineRefundAfterAttempt(plan, { error: new Error("payment not found") });
    expect(read).toEqual({ plan, refused: [], unmadeCents: 1500, refusedCents: 0, unansweredCents: 1500, reachedStripe: false });
    expect(read.plan).toBe(plan);
  });
});

describe("which refusals the officers hear of (#4117)", () => {
  it("a slice refused on the key it was first planned under, never one already moved", () => {
    const first = { slice: { paymentTransactionId: "txn_a", amountCents: 1000 } };
    const again = { slice: { paymentTransactionId: "txn_b", amountCents: 500, stripeKeySuffix: "refused1" } };
    expect(firstRefusals([first, again])).toEqual([first]);
  });

  it("the state names the refused part, the alert adds that it will be retried", () => {
    expect(refusedRefundMessage(500, CLUB_FORMAT_TEST)).toBe(
      "Stripe refused $5.00 of this card refund (failed or cancelled), so that $5.00 did not go back and is still owed.",
    );
    expect(refusedRefundAlertMessage(500, CLUB_FORMAT_TEST)).toBe(
      "Stripe refused $5.00 of this card refund (failed or cancelled), so that $5.00 did not go back and is still owed; it will be retried automatically.",
    );
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
      refund: async () => ({ refunds: [{ status: "failed", slice, refundId: "re_1", paymentIntentId: "pi_1" }] }),
    }).catch((error: unknown) => error)) as Error;

    expect(failure.message).toMatch(/Stripe refused \$500\.00 .*still owed/);
    expect(lastErrorSuggestsStripeMayHaveRefunded(failure.message)).toBe(false);
  });
});

// #4117: the runner alerts once per refused slice - when a slice is first moved
// off the key it was planned under - not once per row.
describe("the runner's refusal alert", () => {
  const held = { id: "op_1", bookingId: "b1", paymentIntentId: "pi_row", processingStartedAt: new Date("2026-06-20T00:00:00.000Z") };
  const moved = { paymentTransactionId: "txn_a", amountCents: 1000, stripeKeySuffix: "refused1" };
  const ownKey = { paymentTransactionId: "txn_b", amountCents: 500 };
  const refusedAnswer = (slice: typeof ownKey & { stripeKeySuffix?: string }, intent: string) => ({ status: "failed", slice, refundId: `re_${slice.paymentTransactionId}`, paymentIntentId: intent });

  beforeEach(() => alertPaymentRecoveryOfficers.mockClear());

  it("a slice queued on its own key and refused later is alerted, with its own intent, though the row already left its first keys", async () => {
    await refundPlanOrRetryRefusals({
      operation: held,
      plan: [moved, ownKey],
      format: CLUB_FORMAT_TEST,
      refund: async () => ({ refunds: [refusedAnswer(moved, "pi_a"), refusedAnswer(ownKey, "pi_b")] }),
    }).catch(() => undefined);

    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500, paymentIntentId: "pi_b" }), CLUB_FORMAT_TEST);
  });

  it("a slice refused again on the key it was moved to is not alerted twice", async () => {
    await refundPlanOrRetryRefusals({
      operation: held,
      plan: [moved],
      format: CLUB_FORMAT_TEST,
      refund: async () => ({ refunds: [refusedAnswer(moved, "pi_a")] }),
    }).catch(() => undefined);

    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });
});


// #4103 (`INV-PAY-130`): every door whose row is written BEFORE its attempt -
// the cancellation, the edit review, the late-capture approval, the duplicate
// capture, the capacity race - re-plans that row through one helper.
// #4103 review C3: a fixed-key refund's key moves on once per refusal Stripe
// holds for it; a refund made (or one whose answer was lost) keeps its key.
describe("keyAfterStripeRefusals", () => {
  const match = { amountCents: 9000, reason: "organiser_cancellation" };
  const refund = (status: string | null, amount = 9000, reason = "organiser_cancellation") => ({ status, amount, metadata: { reason } });

  it("no refusal: the key it has always been sent under", () => {
    expect(keyAfterStripeRefusals("k", [], match)).toBe("k");
    expect(keyAfterStripeRefusals("k", [refund("succeeded"), refund("pending")], match)).toBe("k");
  });

  it("one generation per refusal of this refund, and none for another amount or reason", () => {
    expect(keyAfterStripeRefusals("k", [refund("failed")], match)).toBe("k_refused1");
    expect(keyAfterStripeRefusals("k", [refund("failed"), refund("canceled"), refund("failed", 100), refund("failed", 9000, "other")], match)).toBe("k_refused2");
  });

  it("a refund made after a refusal keeps the key that made it, so its replay is answered with it", () => {
    expect(keyAfterStripeRefusals("k", [refund("failed"), refund("succeeded")], match)).toBe("k_refused1");
  });
});

describe("a pre-persisted row after a refusal (#4103)", () => {
  const a = { paymentTransactionId: "txn_a", amountCents: 1000 };
  const b = { paymentTransactionId: "txn_b", amountCents: 500 };
  const c = { paymentTransactionId: "txn_c", amountCents: 250 };
  const answer = (slice: typeof a, status: string) => ({ status, slice, refundId: `re_${slice.paymentTransactionId}`, paymentIntentId: `pi_${slice.paymentTransactionId}` });
  const keep = (attempt: RefundAttempt, extra: { plan?: Array<typeof a>; alertOfficers?: boolean } = {}) =>
    keepRefusedPrePersistedRefundOwed({ bookingId: "b1", idempotencyKey: "row_key", attempt, format: CLUB_FORMAT_TEST, ...extra });
  const writtenPlan = () => (updateMany.mock.calls[0]?.[0] as { data: { allocationPlan: unknown } }).data.allocationPlan;

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    findUnique.mockClear();
    alertPaymentRecoveryOfficers.mockClear();
  });

  it("a clean refusal: the row is re-planned on the next key, only while untouched, and alerted once", async () => {
    const error = await keep({ refunds: [answer(a, "failed")] });

    expect(error?.message).toMatch(/Stripe refused \$10\.00 .*still owed/);
    expect(updateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: "row_key", status: "PENDING", attempts: 0, allocationPlan: { equals: Prisma.DbNull } },
      data: { allocationPlan: [{ ...a, stripeKeySuffix: "refused1" }], lastError: error?.message },
    });
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "b1", operationId: "op_row", amountCents: 1000, paymentIntentId: "pi_txn_a" }),
      CLUB_FORMAT_TEST,
    );
  });

  it("one made and one refused: the made slice is marked with its refund, the refused one moves; the alert names only the refusal", async () => {
    await keep({ refunds: [answer(a, "succeeded"), answer(b, "canceled")] });

    expect(writtenPlan()).toEqual([{ ...a, madeRefundId: "re_txn_a" }, { ...b, stripeKeySuffix: "refused1" }]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500 }), CLUB_FORMAT_TEST);
  });

  it("refused then thrown: the refusal moves, the made slice is marked, the slice that threw and the one never sent keep their keys", async () => {
    const thrown = new PartialRefundError({
      completedRefundCents: 0,
      refunds: [answer(a, "failed"), answer(b, "succeeded")].map((each) => ({ ...each, amountCents: each.slice.amountCents })),
      refusedSlices: [a],
      cause: new Error("network"),
      format: CLUB_FORMAT_TEST,
    });

    const error = await keep({ error: thrown }, { plan: [a, b, c] });

    expect(error).not.toBeNull();
    expect(writtenPlan()).toEqual([{ ...a, stripeKeySuffix: "refused1" }, { ...b, madeRefundId: "re_txn_b" }, c]);
    expect(alertPaymentRecoveryOfficers).toHaveBeenCalledTimes(1);
  });

  // #4103 review C2: once per refusal. The re-plan starts from the row's own
  // plan and is written compare-and-set on it, so two deliveries that read the
  // same refusal move the slice once and alert once.
  it("re-plans from the plan the row holds, compare-and-set on it", async () => {
    findUnique.mockResolvedValueOnce({ id: "op_row", paymentIntentId: "pi_row", allocationPlan: [a, b] });

    const error = await keep({ refunds: [answer(a, "failed")] });

    expect(error?.replanned).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { idempotencyKey: "row_key", status: "PENDING", attempts: 0, allocationPlan: { equals: [a, b] } },
      data: { allocationPlan: [{ ...a, stripeKeySuffix: "refused1" }, b], lastError: error?.message },
    });
  });

  it("a second delivery of the same refusal finds the slice already moved: no write, no alert", async () => {
    findUnique.mockResolvedValueOnce({ id: "op_row", paymentIntentId: "pi_row", allocationPlan: [{ ...a, stripeKeySuffix: "refused1" }] });

    const error = await keep({ refunds: [answer(a, "failed")] }, { plan: [a] });

    expect(error?.replanned).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it("a replay against a row a worker already holds moves nothing and alerts nobody: the runner reads the refusal itself", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    const error = await keep({ refunds: [answer(a, "failed")] });

    expect(error).not.toBeNull();
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it("a door with its own failure alert re-plans without a second alert", async () => {
    await keep({ refunds: [answer(a, "failed")] }, { alertOfficers: false });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it.each([
    ["every slice made", { refunds: [answer(a, "succeeded"), answer(b, "pending")] }],
    ["a throw before any Stripe call", { error: new Error("payment not found") }],
    ["its own refusal, met again in the door's catch", { error: new Error("Stripe refused $10.00") }],
  ])("nothing refused (%s): no write, no alert, no error", async (_label, attempt) => {
    expect(await keep(attempt)).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });

  it("a write that fails leaves the row open and still returns the refusal, never throwing into the door", async () => {
    updateMany.mockRejectedValue(new Error("db down"));

    await expect(keep({ refunds: [answer(a, "failed")] })).resolves.toBeInstanceOf(Error);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
  });
});

// #4103 (`INV-PAY-130`): a door with no row to carry a slice's key generation
// reads it from the refusals already recorded for that slice.
describe("a slice's key generation, read from the refusals recorded for it (#4103)", () => {
  const slice = { paymentTransactionId: "txn_a", amountCents: 1000 };
  const recorded = (status: string, overrides: Partial<{ paymentTransactionId: string | null; amountCents: number }> = {}) => ({
    paymentTransactionId: "txn_a",
    amountCents: 1000,
    status,
    ...overrides,
  });

  it.each([
    ["nothing recorded", [], undefined],
    ["one refusal", [recorded("failed")], "refused1"],
    ["two refusals", [recorded("failed"), recorded("canceled")], "refused2"],
    ["made refunds only", [recorded("succeeded"), recorded("pending")], undefined],
    ["another transaction's refusal", [recorded("failed", { paymentTransactionId: "txn_b" })], undefined],
    ["a refusal of another amount", [recorded("failed", { amountCents: 999 })], undefined],
    ["a refusal on no transaction", [recorded("failed", { paymentTransactionId: null })], undefined],
  ])("%s: %s", (_label, rows, suffix) => {
    const after = sliceAfterRecordedRefusals(slice, rows);
    expect(after).toEqual(suffix ? { ...slice, stripeKeySuffix: suffix } : slice);
    expect(isRefusedRefundKeySuffix(after.stripeKeySuffix ?? "refused1")).toBe(true);
  });
});
