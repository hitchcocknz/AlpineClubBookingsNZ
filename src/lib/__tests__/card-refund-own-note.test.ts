/**
 * #4312 review: a refund request's recovery replay notes EVERY card refund it
 * made, whatever the replay's own outcome (`replayNotingEachRefund`) - a
 * success, a slice Stripe refused (the replay then throws to retry it), or a
 * slice that threw after earlier ones were made (`PartialRefundError`). A row
 * an older approval wrote asks for nothing. Proven end to end on real
 * PostgreSQL by `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { paymentRecoveryOperation: { updateMany: vi.fn() } } }));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: vi.fn() }));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ noteLateCaptureRefunds: vi.fn() }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({ findLateCapturePaymentIntents: vi.fn() }));

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { replayNotingEachRefund } from "@/lib/card-refund-own-note";
import { PartialRefundError } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { refundPlanOrRetryRefusals } from "@/lib/refused-card-refund-retry";

const input = (notesEachRefund: boolean) => ({
  paymentId: "payment-1",
  operationId: "operation-1",
  notesEachRefund,
  plan: [{ madeRefundId: "re_inline" }, {}, {}],
});

describe("replayNotingEachRefund (#4312 review)", () => {
  it("a replay that succeeds asks for each refund made - the plan's and its own", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const result = await replayNotingEachRefund(input(true), async (send) => {
      await send(async () => ({ refunds: [{ refundId: "re_a", status: "succeeded" }, { refundId: "re_b", status: "pending" }] }));
      return "re_inline";
    }, queue);
    expect(result).toBe("re_inline");
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_a", "re_b"] });
  });

  it("a slice Stripe refused fails the replay, and the refunds it made beside it are still asked for", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const refused = new Error("refused");
    await expect(
      replayNotingEachRefund(input(true), async (send) => {
        await send(async () => ({ refunds: [{ refundId: "re_made", status: "succeeded" }, { refundId: "re_refused", status: "failed" }] }));
        throw refused;
      }, queue),
    ).rejects.toBe(refused);
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_made"] });
  });

  const partialFailure = () =>
    new PartialRefundError({
      completedRefundCents: 2_000,
      refunds: [
        { paymentIntentId: "pi_1", refundId: "re_before", amountCents: 2_000, status: "succeeded", slice: { paymentTransactionId: "txn_1", amountCents: 2_000 } },
        { paymentIntentId: "pi_1", refundId: "re_cancelled", amountCents: 500, status: "canceled", slice: { paymentTransactionId: "txn_2", amountCents: 500 } },
      ],
      cause: new Error("network"),
      format: CLUB_FORMAT_TEST,
    });

  it("a slice that threw after earlier ones were made: the made ones are read off the error and asked for", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const partial = partialFailure();
    await expect(replayNotingEachRefund(input(true), (send) => send(async () => { throw partial; }), queue)).rejects.toBe(partial);
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_before"] });
  });

  it("MUTATION: re-planning the row after a partial failure throws its own error - the refunds made are still asked for on this attempt", async () => {
    // `refundPlanOrRetryRefusals` re-plans the row from the partial failure's answers before
    // rethrowing it; when that write fails, the error the replay ends on carries no answers.
    vi.mocked(prisma.paymentRecoveryOperation.updateMany).mockRejectedValueOnce(new Error("database unavailable"));
    const queue = vi.fn().mockResolvedValue([]);
    const operation = { id: "operation-1", processingStartedAt: new Date(0), bookingId: "booking-1", paymentIntentId: "pi_1" };
    const plan = [{ paymentTransactionId: "txn_1", amountCents: 2_000 }, { paymentTransactionId: "txn_2", amountCents: 500 }];
    await expect(
      replayNotingEachRefund({ ...input(true), plan }, (send) =>
        refundPlanOrRetryRefusals({ operation, plan, format: CLUB_FORMAT_TEST, refund: () => send(async () => { throw partialFailure(); }) }),
      queue),
    ).rejects.toThrow("database unavailable");
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_before"] });
  });

  it("a row an older approval wrote asks for nothing, whatever the replay made", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    await replayNotingEachRefund(input(false), (send) => send(async () => ({ refunds: [{ refundId: "re_a", status: "succeeded" }] })), queue);
    expect(queue).not.toHaveBeenCalled();
  });

  it("a note that cannot be queued never fails the replay: the money has moved", async () => {
    const queue = vi.fn().mockRejectedValue(new Error("outbox down"));
    await expect(replayNotingEachRefund(input(true), async () => "done", queue)).resolves.toBe("done");
    expect(queue).toHaveBeenCalledTimes(1);
  });
});
