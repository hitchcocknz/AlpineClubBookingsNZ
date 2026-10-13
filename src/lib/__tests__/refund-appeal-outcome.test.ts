// #4117 (`INV-PAY-128`): what an approved refund appeal has still to give back,
// as the refund-requests screen reads it - so "Refunded" is what went back.
import { describe, expect, it, vi } from "vitest";

import { readApprovedAppealOutcomes } from "@/lib/refund-appeal-outcome";

const AT = new Date("2026-06-20T00:00:05.000Z");
const MADE_AT = new Date("2026-06-20T00:00:01.000Z");

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "op-1",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "PENDING",
    attempts: 0,
    nextRetryAt: AT,
    idempotencyKey: "refund_request_refund_rq-1",
    amountCents: 2_500,
    allocationPlan: [
      { paymentTransactionId: "txn-new", amountCents: 1_500, madeRefundId: "re_made" },
      { paymentTransactionId: "txn-old", amountCents: 1_000, stripeKeySuffix: "refused1" },
    ],
    paymentTransactionId: null,
    createdAt: AT,
    succeededAt: null,
    ...overrides,
  };
}

function db({
  operations = [operation()],
  refundedAmountCents = 1_500,
  audits = [] as Array<{ entityId: string; metadata: unknown }>,
  tasks = [] as Array<{ occurrenceKey: string; amountCents: number | null }>,
} = {}) {
  return {
    payment: {
      findMany: vi.fn(async () => [
        {
          id: "p-1",
          status: "PARTIALLY_REFUNDED",
          amountCents: 10_000,
          refundedAmountCents,
          recoveryOperations: operations,
          refunds: [
            { stripeRefundId: "re_made", paymentTransactionId: "txn-new", amountCents: 1_500, status: "succeeded", createdAt: MADE_AT, stripeCreatedAt: MADE_AT },
          ],
        },
      ]),
    },
    auditLog: { findMany: vi.fn(async () => audits) },
    manualRefundTask: { findMany: vi.fn(async () => tasks) },
  };
}

const approved = { id: "rq-1", status: "APPROVED", booking: { payment: { id: "p-1" } } };

async function outcomeOf(store: ReturnType<typeof db>) {
  return (await readApprovedAppealOutcomes(store as never, [approved])).get("rq-1");
}

describe("an approved appeal's card refund, read from its recovery row", () => {
  it("retrying: the made slice is filled by its own refund; only the refused part is owed", async () => {
    expect(await outcomeOf(db())).toMatchObject({ cardRefundState: "retrying", cardRefundOwedCents: 1_000, handBackOwedCents: 0 });
  });

  it("dead (retries spent): still owed, not queued for retry", async () => {
    expect(await outcomeOf(db({ operations: [operation({ status: "FAILED", attempts: 5, nextRetryAt: null })] }))).toMatchObject({
      cardRefundState: "dead",
      cardRefundOwedCents: 1_000,
    });
  });

  it("capped per payment, as Refunds owed is: never more than the payment still holds", async () => {
    expect(await outcomeOf(db({ refundedAmountCents: 9_600 }))).toMatchObject({ cardRefundState: "retrying", cardRefundOwedCents: 400 });
  });

  it("closed: made, nothing owed", async () => {
    expect(await outcomeOf(db({ operations: [operation({ status: "SUCCEEDED", succeededAt: new Date("2026-06-21T00:00:00.000Z") })] }))).toMatchObject({
      cardRefundState: "made",
      cardRefundOwedCents: 0,
    });
  });
});

describe("an approved appeal with no recovery row", () => {
  it("not queued: the approval's audit row is the record, split into refused and unanswered", async () => {
    const store = db({
      operations: [],
      audits: [
        { entityId: "rq-1", metadata: { cardRefundOwedCents: 2_500, cardRefundQueued: false, cardRefundRefusedCents: 1_500, cardRefundUnansweredCents: 1_000 } },
      ],
    });
    expect(await outcomeOf(store)).toEqual({
      cardRefundState: "not_queued",
      cardRefundOwedCents: 2_500,
      cardRefundRefusedCents: 1_500,
      cardRefundUnansweredCents: 1_000,
      handBackOwedCents: 0,
    });
  });

  it("an audit row that queued its retry, or owes nothing, is made", async () => {
    const store = db({ operations: [], audits: [{ entityId: "rq-1", metadata: { cardRefundOwedCents: 2_500, cardRefundQueued: true } }] });
    expect(await outcomeOf(store)).toMatchObject({ cardRefundState: "made", cardRefundOwedCents: 0 });
  });
});

describe("the bank-transfer part", () => {
  it("this request's own OPEN hand-back task is still owed; another request's is not read", async () => {
    const store = db({
      operations: [],
      tasks: [
        { occurrenceKey: "refund-request-hand-back:rq-1", amountCents: 3_000 },
        { occurrenceKey: "refund-request-hand-back:rq-2", amountCents: 9_000 },
      ],
    });
    expect(await outcomeOf(store)).toMatchObject({ cardRefundState: "made", handBackOwedCents: 3_000 });
    expect(store.manualRefundTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { occurrenceKey: { in: ["refund-request-hand-back:rq-1"] }, status: "OPEN" } }),
    );
  });
});

it("reads nothing for a page with no approved appeal", async () => {
  const store = db();
  expect((await readApprovedAppealOutcomes(store as never, [{ ...approved, status: "PENDING" }])).size).toBe(0);
  expect(store.payment.findMany).not.toHaveBeenCalled();
});
