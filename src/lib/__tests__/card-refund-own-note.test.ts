/**
 * #4312 review: a refund request's recovery replay notes EVERY card refund it
 * made, whatever the replay's own outcome (`replayNotingEachRefund`) - a
 * success, a slice Stripe refused (the replay then throws to retry it), or a
 * slice that threw after earlier ones were made (`PartialRefundError`). A row
 * an older approval wrote asks for nothing. Proven end to end on real
 * PostgreSQL by `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { updateMany: vi.fn() },
    payment: { findUnique: vi.fn(async () => ({ source: "INTERNET_BANKING" })) },
    paymentRefund: {
      findMany: vi.fn(async ({ where }: { where: { stripeRefundId: { in: string[] } } }) =>
        where.stripeRefundId.in.map((stripeRefundId) => ({ stripeRefundId, amountCents: 4_000, stripePaymentIntentId: "pi_card", stripeCreatedAt: null, createdAt: new Date(0) })),
      ),
    },
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroRefundCreditNoteOperation: vi.fn() }));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ noteLateCaptureRefunds: vi.fn() }));
vi.mock("@/lib/late-capture-xero-receipt", () => ({ findLateCapturePaymentIntents: vi.fn(async () => new Set()) }));
vi.mock("@/lib/card-refund-resend-answer", () => ({ readFailedRefundsAnsweredBy: vi.fn() }));
vi.mock("@/lib/card-refund-own-note-share", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/card-refund-own-note-share")),
  cardRefundNoteCutoverSeconds: async () => null,
}));

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { queueAnsweringRefundNotes, queueWebhookCardRefundNotes, replayNotingEachRefund } from "@/lib/card-refund-own-note";
import { readFailedRefundsAnsweredBy } from "@/lib/card-refund-resend-answer";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import { PaymentSource } from "@prisma/client";
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
    const plan: Array<{ paymentTransactionId: string; amountCents: number; madeRefundId?: string }> = [{ paymentTransactionId: "txn_1", amountCents: 2_000 }, { paymentTransactionId: "txn_2", amountCents: 500 }];
    await expect(
      replayNotingEachRefund({ ...input(true), plan }, (send) =>
        refundPlanOrRetryRefusals({ operation, plan, format: CLUB_FORMAT_TEST, refund: () => send(async () => { throw partialFailure(); }) }),
      queue),
    ).rejects.toThrow("database unavailable");
    expect(queue).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_before"] });
  });

  it("MUTATION (round 6): any other row - an older approval's, a failed-later row - asks only by the one rule, never for each refund", async () => {
    const queue = vi.fn().mockResolvedValue([]);
    const answering = vi.fn().mockResolvedValue([]);
    await replayNotingEachRefund(input(false), (send) => send(async () => ({ refunds: [{ refundId: "re_a", status: "succeeded" }] })), queue, answering);
    expect(queue).not.toHaveBeenCalled();
    expect(answering).toHaveBeenCalledWith({ paymentId: "payment-1", stripeRefundIds: ["re_inline", "re_a"] });
  });

  it("a note that cannot be queued never fails the replay: the money has moved", async () => {
    const queue = vi.fn().mockRejectedValue(new Error("outbox down"));
    await expect(replayNotingEachRefund(input(true), async () => "done", queue)).resolves.toBe("done");
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe("one rule for a re-send's own note: the replay and charge.refunded agree (#4312 round 6, finding 3)", () => {
  const answers = (ownNoted: Record<string, boolean>) =>
    vi.mocked(readFailedRefundsAnsweredBy).mockImplementation(async (_db, _paymentId, id) => ({ failedRefundIds: ownNoted[id] ? ["re_failed"] : [], ownNoted: ownNoted[id] ?? false, coverCents: ownNoted[id] ? 4_000 : 0 }));
  const appDoor = (id: string) => ({ id, amount: 4_000, metadata: { reason: "card_refund_failed_later", bookingId: "booking-1" } });

  /** Which refunds each writer asks for on its own record, and the canonical delta charge.refunded queues, for one refund. */
  async function bothWriters(id: string) {
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset().mockResolvedValue({ queueOperationId: "op" } as never);
    await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: [id] });
    const replayOwn = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls.filter(([, , options]) => options?.cardRefundId === id).length;
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockClear();
    await queueWebhookCardRefundNotes({ payment: { id: "payment-1", source: PaymentSource.INTERNET_BANKING }, deltaCents: 4_000, refunds: [appDoor(id)], newlyCountedRefundIds: [id] });
    const calls = vi.mocked(enqueueXeroRefundCreditNoteOperation).mock.calls;
    return { replayOwn, webhookOwn: calls.filter(([, , options]) => options?.cardRefundId === id).length, webhookCanonicalCents: calls.filter(([, , options]) => !options?.cardRefundId).reduce((sum, [, cents]) => sum + cents, 0) };
  }

  it("MUTATION: a re-send the owed figure pairs with an own-noted failure: both writers ask for its own note, neither for the canonical delta", async () => {
    answers({ re_s: true });
    expect(await bothWriters("re_s")).toEqual({ replayOwn: 1, webhookOwn: 1, webhookCanonicalCents: 0 });
  });

  it("MUTATION: a re-send its row made that the owed figure pairs with nothing: neither writer asks for an own note - only the canonical delta, once", async () => {
    // The 3A path: a runner asking by its key's failure would add an own note of $40 beside the webhook's canonical $40.
    answers({ re_s: false });
    expect(await bothWriters("re_s")).toEqual({ replayOwn: 0, webhookOwn: 0, webhookCanonicalCents: 4_000 });
  });

  it("asks nothing on a card payment", async () => {
    answers({ re_s: true });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.payment.findUnique).mockResolvedValueOnce({ source: "STRIPE" } as never);
    vi.mocked(enqueueXeroRefundCreditNoteOperation).mockReset();
    expect(await queueAnsweringRefundNotes({ paymentId: "payment-1", stripeRefundIds: ["re_s"] })).toEqual([]);
    expect(enqueueXeroRefundCreditNoteOperation).not.toHaveBeenCalled();
  });
});
