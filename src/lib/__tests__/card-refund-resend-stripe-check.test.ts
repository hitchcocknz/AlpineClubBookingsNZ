// #4359 (#4361 wave 1, design D; `INV-PAY-142`): the recovery runner reads the
// refunds Stripe holds before it sends a card refund, records the ones the app
// has not seen, and holds the row past a refund made outside the app since the
// debt arose. The decision is pure and proven here case by case; the runner's
// hold (attempts spent, alert, audit) and the real writers are proven in
// `card-refund-resend-stripe-check.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transactionFindMany: vi.fn(),
  refundFindMany: vi.fn(),
  listRefunds: vi.fn(),
  recordChargeRefunds: vi.fn(async () => undefined),
  createAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentTransaction: { findMany: mocks.transactionFindMany },
    paymentRefund: { findMany: mocks.refundFindMany },
  },
}));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: mocks.listRefunds }));
vi.mock("@/lib/stripe-webhook-service", () => ({ recordChargeRefunds: mocks.recordChargeRefunds }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import type Stripe from "stripe";

import {
  auditCardRefundResendHeld,
  cardRefundDebtAroseAtSeconds,
  CardRefundResendHeldError,
  checkStripeBeforeCardRefundSend,
  dashboardRefundsHoldingSend,
  type CardRefundSendOperation,
} from "@/lib/card-refund-resend-stripe-check";
import { READ_BACK_TIMEOUT_MS } from "@/lib/card-refund-status-sync";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import {
  buildBookingCancellationRefundIdempotencyKey,
  buildBookingCancellationRefundMetadata,
  CARD_REFUND_FAILED_LATER_REASON,
} from "@/lib/payment-recovery-keys";
import { CARD_REFUND_RESEND_HELD_CODE, isCardRefundResendHeldError } from "@/lib/payment-recovery-constants";
import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";

const RAISED_AT = new Date("2026-06-20T00:00:10.600Z");
const RAISED_SECONDS = Math.floor(RAISED_AT.getTime() / 1000);
const FAILED_REFUND_MADE = RAISED_SECONDS - 3_600;

const cancellationRow: CardRefundSendOperation = {
  id: "op-1",
  type: "REFUND_BOOKING_MODIFICATION",
  idempotencyKey: buildBookingCancellationRefundIdempotencyKey("booking-1"),
  stripeKeyPrefix: null,
  bookingId: "booking-1",
  paymentId: "pay-1",
  createdAt: RAISED_AT,
};
const failedLaterRow: CardRefundSendOperation = {
  ...cancellationRow,
  idempotencyKey: "card_refund_failed_later_re_failed",
  stripeKeyPrefix: "card_refund_failed_later_re_failed",
};
const SLICE = { paymentTransactionId: "txn-1", amountCents: 4_000 };

const refund = (id: string, created: number, metadata: Record<string, string> | null, extra: Partial<Stripe.Refund> = {}) =>
  ({ id, object: "refund", amount: 4_000, currency: "nzd", status: "succeeded", created, metadata, charge: "ch_1", payment_intent: "pi_1", ...extra }) as Stripe.Refund;
const appMetadata = { bookingId: "booking-1", reason: "booking_cancellation" };
const failedRefund = refund("re_failed", FAILED_REFUND_MADE, appMetadata, { status: "failed" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindMany.mockResolvedValue([{ id: "txn-1", stripePaymentIntentId: "pi_1" }]);
  mocks.refundFindMany.mockResolvedValue([]);
  mocks.listRefunds.mockResolvedValue([]);
});

describe("when the debt a slice is sent for arose (Stripe's clock, whole seconds)", () => {
  it("a slice sent for nothing that failed: when the row was raised, floored to its second", () => {
    expect(cardRefundDebtAroseAtSeconds(cancellationRow, { slice: SLICE, onIntent: [failedRefund] })).toBe(RAISED_SECONDS);
  });

  it("a failed-later row's own slice: when Stripe made the refund it failed (its key names it)", () => {
    expect(cardRefundDebtAroseAtSeconds(failedLaterRow, { slice: SLICE, onIntent: [failedRefund] })).toBe(FAILED_REFUND_MADE);
  });

  it("a re-planned slice: the earliest refund it records as failed later", () => {
    const later = refund("re_failed_2", FAILED_REFUND_MADE + 50, appMetadata, { status: "failed" });
    const slice = { ...SLICE, stripeKeySuffix: "refused2", failedRefundIds: ["re_failed_2", "re_failed"] };
    expect(cardRefundDebtAroseAtSeconds(cancellationRow, { slice, onIntent: [later, failedRefund] })).toBe(FAILED_REFUND_MADE);
  });

  it("a refused slice: the earliest refusal of its amount this row's runner could have sent", () => {
    const metadata = buildBookingCancellationRefundMetadata("booking-1");
    const refused = refund("re_refused", RAISED_SECONDS + 20, metadata, { status: "failed" });
    const otherDoor = refund("re_other", RAISED_SECONDS + 5, { bookingId: "booking-1", reason: "something_else" }, { status: "failed" });
    const otherAmount = refund("re_other_amount", RAISED_SECONDS + 1, metadata, { status: "failed", amount: 1_000 });
    const slice = { ...SLICE, stripeKeySuffix: "refused1" };
    expect(cardRefundDebtAroseAtSeconds(cancellationRow, { slice, onIntent: [refused, otherDoor, otherAmount] })).toBe(RAISED_SECONDS + 20);
  });

  it("a refused or failed-later slice whose refund Stripe does not list: when the row was raised", () => {
    expect(cardRefundDebtAroseAtSeconds(cancellationRow, { slice: { ...SLICE, stripeKeySuffix: "refused1" }, onIntent: [] })).toBe(RAISED_SECONDS);
    expect(cardRefundDebtAroseAtSeconds(failedLaterRow, { slice: SLICE, onIntent: [] })).toBe(RAISED_SECONDS);
  });
});

describe("the hold: a counted refund made outside the app, at or after the debt arose", () => {
  const holds = (operation: CardRefundSendOperation, onIntent: Stripe.Refund[]) =>
    dashboardRefundsHoldingSend(operation, [{ slice: SLICE, onIntent }]).map((hold) => hold.refund.id);

  it("holds for a dashboard refund made after the debt arose, of any amount", () => {
    expect(holds(failedLaterRow, [failedRefund, refund("re_dash", FAILED_REFUND_MADE + 60, null, { amount: 1_234 })])).toEqual(["re_dash"]);
  });

  it("holds for one made in the very second the debt arose (at or after, not after)", () => {
    expect(holds(cancellationRow, [refund("re_dash", RAISED_SECONDS, {})])).toEqual(["re_dash"]);
  });

  it("MUTATION (ordering): never for one Stripe made before the debt arose", () => {
    expect(holds(failedLaterRow, [failedRefund, refund("re_dash", FAILED_REFUND_MADE - 1, null)])).toEqual([]);
    expect(holds(cancellationRow, [refund("re_dash", RAISED_SECONDS - 1, null)])).toEqual([]);
  });

  it("never for a refund carrying app metadata - any door's, a refund request's, a failed-later retry's", () => {
    expect(
      holds(cancellationRow, [
        refund("re_app", RAISED_SECONDS + 5, appMetadata),
        refund("re_request", RAISED_SECONDS + 5, { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" }),
        refund("re_retry", RAISED_SECONDS + 5, { bookingId: "booking-1", reason: CARD_REFUND_FAILED_LATER_REASON }),
      ]),
    ).toEqual([]);
  });

  it("never for a dashboard refund Stripe failed or cancelled: no money went back", () => {
    expect(
      holds(cancellationRow, [refund("re_failed_dash", RAISED_SECONDS + 5, null, { status: "failed" }), refund("re_cancelled_dash", RAISED_SECONDS + 5, null, { status: "canceled" })]),
    ).toEqual([]);
  });

  it("holds for a dashboard refund still pending: Stripe counts it", () => {
    expect(holds(cancellationRow, [refund("re_dash", RAISED_SECONDS + 5, null, { status: "pending" })])).toEqual(["re_dash"]);
  });
});

describe("the check before the runner's send", () => {
  const dashboard = refund("re_dash", FAILED_REFUND_MADE + 60, null);

  it("reads nothing when every slice is already made (`madeRefundId`): nothing will be sent", async () => {
    await checkStripeBeforeCardRefundSend({ operation: cancellationRow, plan: [{ ...SLICE, madeRefundId: "re_made" }], format: CLUB_FORMAT_TEST });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });

  it("reads each intent once, bounded with no retries, and returns when nothing holds it", async () => {
    mocks.listRefunds.mockResolvedValue([refund("re_app", RAISED_SECONDS + 5, appMetadata)]);
    mocks.refundFindMany.mockResolvedValue([{ stripeRefundId: "re_app" }]);
    await checkStripeBeforeCardRefundSend({ operation: cancellationRow, plan: [SLICE, { ...SLICE, amountCents: 500 }], format: CLUB_FORMAT_TEST });
    expect(mocks.listRefunds).toHaveBeenCalledTimes(1);
    expect(mocks.listRefunds).toHaveBeenCalledWith("pi_1", { timeoutMs: READ_BACK_TIMEOUT_MS });
    expect(mocks.recordChargeRefunds).not.toHaveBeenCalled();
  });

  it("a read that fails throws an ordinary error: the attempt fails for the backoff, nothing is recorded or held", async () => {
    mocks.listRefunds.mockRejectedValue(new Error("Request timed out"));
    const thrown = await checkStripeBeforeCardRefundSend({ operation: failedLaterRow, plan: [SLICE], format: CLUB_FORMAT_TEST }).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CardRefundResendHeldError);
    expect((thrown as Error).message).toContain("nothing was sent");
    expect(mocks.recordChargeRefunds).not.toHaveBeenCalled();
  });

  it("records only the refunds the app has not seen, per charge, beside the whole charge's list", async () => {
    const seenApp = refund("re_app", RAISED_SECONDS + 5, appMetadata);
    mocks.listRefunds.mockResolvedValue([failedRefund, seenApp, dashboard]);
    mocks.refundFindMany.mockResolvedValue([{ stripeRefundId: "re_failed" }, { stripeRefundId: "re_app" }]);
    await expect(checkStripeBeforeCardRefundSend({ operation: failedLaterRow, plan: [SLICE], format: CLUB_FORMAT_TEST })).rejects.toBeInstanceOf(
      CardRefundResendHeldError,
    );
    expect(mocks.recordChargeRefunds).toHaveBeenCalledTimes(1);
    expect(mocks.recordChargeRefunds).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
      chargeId: "ch_1",
      amountRefundedCents: 8_000,
      refunds: [failedRefund, seenApp, dashboard],
      record: [dashboard],
    });
  });

  it("a record that fails throws before the decision: nothing is sent", async () => {
    mocks.listRefunds.mockResolvedValue([dashboard]);
    mocks.recordChargeRefunds.mockRejectedValueOnce(new Error("database gone"));
    await expect(checkStripeBeforeCardRefundSend({ operation: failedLaterRow, plan: [SLICE], format: CLUB_FORMAT_TEST })).rejects.toThrow("database gone");
  });

  it("MUTATION (hold): a dashboard refund since the debt arose holds the whole row, coded, for every slice it would send", async () => {
    mocks.listRefunds.mockResolvedValue([failedRefund, dashboard]);
    mocks.refundFindMany.mockResolvedValue([{ stripeRefundId: "re_failed" }, { stripeRefundId: "re_dash" }]);
    const thrown = (await checkStripeBeforeCardRefundSend({
      operation: failedLaterRow,
      plan: [SLICE, { ...SLICE, amountCents: 500 }, { ...SLICE, amountCents: 700, madeRefundId: "re_made" }],
      format: CLUB_FORMAT_TEST,
    }).catch((err: unknown) => err)) as CardRefundResendHeldError;
    expect(thrown).toBeInstanceOf(CardRefundResendHeldError);
    expect(thrown.heldCents).toBe(4_500);
    expect(thrown.holds.map((hold) => hold.refund.id)).toEqual(["re_dash", "re_dash"]);
    expect(thrown.message.startsWith(`${CARD_REFUND_RESEND_HELD_CODE}:`)).toBe(true);
    expect(thrown.message).toContain("re_dash");
    expect(isCardRefundResendHeldError(thrown.message)).toBe(true);
    // Stuck States tells the treasurer to check Stripe first.
    expect(lastErrorSuggestsStripeMayHaveRefunded(thrown.message)).toBe(true);
    expect(thrown.alertMessage).toContain("$45.00");
    expect(thrown.alertMessage).toContain("$40.00");
    expect(thrown.alertMessage).toContain('"Paid another way"');
    expect(thrown.alertMessage).toContain("not with another Stripe dashboard refund");
  });

  it("a slice on a transaction with no Stripe intent is not read for", async () => {
    mocks.transactionFindMany.mockResolvedValue([{ id: "txn-1", stripePaymentIntentId: null }]);
    await checkStripeBeforeCardRefundSend({ operation: cancellationRow, plan: [SLICE], format: CLUB_FORMAT_TEST });
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });
});

describe("the hold's audit row", () => {
  it("is written under payment, naming the row, the refunds that held it and when each debt arose", async () => {
    const held = new CardRefundResendHeldError(
      4_000,
      [{ slice: SLICE, refund: refund("re_dash", RAISED_SECONDS + 5, null), debtAroseAtSeconds: RAISED_SECONDS }],
      ["pi_1"],
      CLUB_FORMAT_TEST,
    );
    await auditCardRefundResendHeld(cancellationRow, held);
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-payment.card-refund.resend-held",
        category: "payment",
        targetId: "booking-1",
        entityType: "PaymentRecoveryOperation",
        entityId: "op-1",
        metadata: expect.objectContaining({
          heldCents: 4_000,
          refunds: [expect.objectContaining({ stripeRefundId: "re_dash", debtAroseAtSeconds: RAISED_SECONDS })],
        }),
      }),
    );
  });

  it("never throws: the row is already held", async () => {
    mocks.createAuditLog.mockRejectedValueOnce(new Error("audit down"));
    const held = new CardRefundResendHeldError(4_000, [], [], CLUB_FORMAT_TEST);
    await expect(auditCardRefundResendHeld(cancellationRow, held)).resolves.toBeUndefined();
  });
});

describe("every runner card refund send is checked first (census, `INV-PAY-142`)", () => {
  it("each `refundPlanOrRetryRefusals` call is the runner's, and follows the check in the same function", async () => {
    const { readFileSync } = await import("node:fs");
    const { execSync } = await import("node:child_process");
    const callers = execSync("git grep -l 'refundPlanOrRetryRefusals(' -- 'src/**/*.ts' ':!src/**/__tests__/**'", { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(callers, "a new caller of the runner's refund must run checkStripeBeforeCardRefundSend before it (#4359)").toEqual([
      "src/lib/payment-recovery.ts",
      "src/lib/refused-card-refund-retry.ts",
    ]);
    const source = readFileSync("src/lib/payment-recovery.ts", "utf8");
    const calls = [...source.matchAll(/refundPlanOrRetryRefusals\(\{/g)].map((match) => match.index ?? 0);
    expect(calls).toHaveLength(2);
    for (const at of calls) {
      const before = source.slice(0, at);
      const check = before.lastIndexOf("await checkStripeBeforeCardRefundSend({ operation, plan, format });");
      const fn = before.lastIndexOf("\nasync function ");
      expect(check, "the check must come before the send, inside the same processor (#4359)").toBeGreaterThan(fn);
    }
  });
});
