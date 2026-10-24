/**
 * #4312 round 5 (#4104, `INV-ADDPAY-045`): which refunds Stripe failed later a
 * card refund was sent again for (`readFailedRefundsAnsweredBy`), read from the
 * links #4104 keeps on the recovery row - a row of its own's key, a re-planned
 * slice's `failedRefundIds` - and what their own notes cover. The real
 * PostgreSQL proofs of each writer are `xero-bt-card-refund-notes.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const lateCaptures = vi.hoisted(() => new Set<string>());
const coverByRefund = vi.hoisted(() => new Map<string, number>());

vi.mock("@/lib/late-capture-xero-receipt", () => ({
  findLateCapturePaymentIntents: async (ids: readonly string[]) => new Set(ids.filter((id) => lateCaptures.has(id))),
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({
  sumRefundCreditNoteCoverageOfRowsCents: async (_paymentId: string, where: { OR: Array<{ requestPayload?: { equals: string } }> }) =>
    coverByRefund.get(where.OR[0]!.requestPayload!.equals) ?? 0,
}));

import { readFailedRefundsAnsweredBy } from "@/lib/card-refund-resend-answer";
import { closeKeysOf } from "@/lib/manual-refund-task-settlement-rules";

const PAYMENT = "payment-1";
const TXN = "txn-card";
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds));

type Refund = {
  stripeRefundId: string; paymentTransactionId: string | null; stripePaymentIntentId: string | null; amountCents: number; status: string;
  createdAt: Date; updatedAt: Date; stripeCreatedAt: Date | null;
};
type Row = {
  id: string; type: string; status: string; idempotencyKey: string; amountCents: number; allocationPlan: unknown;
  paymentTransactionId: string | null; createdAt: Date; succeededAt: Date | null;
};

let refunds: Refund[];
let rows: Row[];
let closes: string[];
let noteRows: Set<string>;

/**
 * A $40 refund Stripe made at `seconds`, recorded then (or at `recordedSeconds`); a failed one failed at
 * `failedSeconds` (its ledger row's last write).
 */
function refund(
  id: string,
  seconds: number,
  status = "succeeded",
  amountCents = 4_000,
  failedSeconds?: number,
  recordedSeconds = seconds,
): Refund {
  return {
    stripeRefundId: id, paymentTransactionId: TXN, stripePaymentIntentId: "pi_card", amountCents, status,
    createdAt: at(recordedSeconds), updatedAt: at(failedSeconds ?? recordedSeconds), stripeCreatedAt: at(seconds),
  };
}

/** A card refund row raised at `seconds` for one $40 slice; open unless `succeededSeconds` closes it. */
function row(id: string, idempotencyKey: string, seconds: number, slice: Record<string, unknown> = {}, succeededSeconds?: number): Row {
  return {
    id, type: "REFUND_BOOKING_MODIFICATION", status: succeededSeconds === undefined ? "PENDING" : "SUCCEEDED", idempotencyKey, amountCents: 4_000,
    allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000, ...slice }], paymentTransactionId: null, createdAt: at(seconds),
    succeededAt: succeededSeconds === undefined ? null : at(succeededSeconds),
  };
}

const db = {
  payment: { findUnique: async () => ({ status: "SUCCEEDED", amountCents: 25_000, refundedAmountCents: 0 }) },
  paymentRefund: { findMany: async () => refunds },
  paymentRecoveryOperation: { findMany: async () => rows },
  manualRefundTask: {
    findMany: async ({ where }: { where: { occurrenceKey: { in: string[] } } }) =>
      closes.filter((key) => where.occurrenceKey.in.includes(key)).map((occurrenceKey) => ({ occurrenceKey })),
  },
  xeroSyncOperation: { count: async ({ where }: { where: { OR: Array<{ requestPayload?: { equals: string } }> } }) => (noteRows.has(where.OR[0]!.requestPayload!.equals) ? 1 : 0) },
  xeroObjectLink: {},
} as never;

const answered = (id: string) => readFailedRefundsAnsweredBy(db, PAYMENT, id);

/**
 * What Xero holds once each refund still counted has been asked for by the one rule (`answersOwnNotedFailure`):
 * the notes already raised (`coverByRefund`), each answering refund's own note at its share (its amount less what
 * the failures it answers cover), and `canonicalCents` for what the canonical note answers.
 */
async function xeroCoverAfterAsking(canonicalCents = 0): Promise<number> {
  let cents = canonicalCents + [...coverByRefund.values()].reduce((sum, each) => sum + each, 0);
  for (const each of refunds.filter((refund) => refund.status === "succeeded")) {
    const answer = await answered(each.stripeRefundId);
    if (answer.ownNoted) cents += Math.max(0, each.amountCents - (coverByRefund.get(each.stripeRefundId) ?? 0) - answer.coverCents);
  }
  return cents;
}

const refundedCents = () => refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amountCents, 0);

beforeEach(() => {
  lateCaptures.clear();
  coverByRefund.clear();
  noteRows = new Set(["re_failed"]);
  coverByRefund.set("re_failed", 4_000);
  closes = [];
  refunds = [refund("re_failed", 5, "failed", 4_000, 10)];
  rows = [row("op-own", "card_refund_failed_later_re_failed", 10)];
});

describe("a card refund sent again for one Stripe failed later (#4312 round 5)", () => {
  it("MUTATION: the first refund recorded after the failure, on its charge for its amount, answers it - with the failed refund's own note", async () => {
    refunds.push(refund("re_before", 8), refund("re_other_amount", 15, "succeeded", 1_000), refund("re_resent", 20), refund("re_later", 30));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    // One refund answers it: a later one of the same amount, an earlier one, another amount - none.
    for (const id of ["re_later", "re_before", "re_other_amount"]) expect(await answered(id)).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
  });

  it("MUTATION: two failures on one charge for one amount: each re-send answers one, newest row first, as the owed figure fills them", async () => {
    rows.push(row("op-own-2", "card_refund_failed_later_re_failed_2", 12));
    noteRows.add("re_failed_2");
    coverByRefund.set("re_failed_2", 4_000);
    refunds.push(refund("re_failed_2", 7, "failed", 4_000, 12), refund("re_resent", 20), refund("re_resent_2", 30));
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed_2"]);
    expect((await answered("re_resent_2")).failedRefundIds).toEqual(["re_failed"]);
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION: a re-planned slice's failures - every one of them - are answered by the refund made after the latest", async () => {
    rows = [row("op-request", "refund_request_refund_request-1", 1, { stripeKeySuffix: "refused2", failedRefundIds: ["re_failed", "re_failed_again"] })];
    refunds.push(refund("re_failed_again", 20, "failed", 4_000, 25), refund("re_resent", 30));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed", "re_failed_again"], ownNoted: true, coverCents: 4_000 });
  });

  it("MUTATION: a slice marked made answers with that refund only", async () => {
    rows = [row("op-own", "card_refund_failed_later_re_failed", 10, { madeRefundId: "re_marked" })];
    refunds.push(refund("re_first", 20), refund("re_marked", 30));
    expect((await answered("re_marked")).failedRefundIds).toEqual(["re_failed"]);
    expect((await answered("re_first")).failedRefundIds).toEqual([]);
  });

  it("MUTATION (round 6, finding 1): a re-send Stripe failed too passes on what it answered - the next refund is answered by the first failure's note", async () => {
    // R1 failed at 10 and was noted at $40; its row of its own sent S1 at 20 and closed; Stripe failed S1 at 25, so a
    // row of its own owes S1 (raised dead: a re-send that failed too). The treasurer refunds in the dashboard at 30.
    rows = [row("op-own", "card_refund_failed_later_re_failed", 10, {}, 20), row("op-own-s1", "card_refund_failed_later_re_s1", 25)];
    // S1 was answered by R1's note, so its own ask raised nothing: no note row, no cover.
    refunds.push(refund("re_s1", 20, "failed", 4_000, 25), refund("re_dashboard", 30));
    expect(await answered("re_dashboard")).toEqual({ failedRefundIds: ["re_s1", "re_failed"], ownNoted: true, coverCents: 4_000 });
    // Xero holds R1's $40 and nothing more: what went back.
    expect(await xeroCoverAfterAsking()).toBe(4_000);
    expect(refundedCents()).toBe(4_000);
  });

  it("MUTATION (round 6, finding 2a): an older row never takes a newer row's re-send", async () => {
    // R2 failed first, at 8, and folded into the canonical note (no note of its own); R1 failed at 10, noted at $40.
    // R1's row sends S at 20, R2's sends S2 at 30.
    noteRows = new Set(["re_failed"]);
    refunds = [refund("re_r2", 3, "failed", 4_000, 8), refund("re_failed", 5, "failed", 4_000, 10), refund("re_s", 20), refund("re_s2", 30)];
    rows = [row("op-own-r2", "card_refund_failed_later_re_r2", 8), row("op-own", "card_refund_failed_later_re_failed", 10)];
    expect(await answered("re_s")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    expect(await answered("re_s2")).toEqual({ failedRefundIds: ["re_r2"], ownNoted: false, coverCents: 0 });
    // R1's note answers S and the canonical note's $40 answers S2: $80 for $80.
    expect(await xeroCoverAfterAsking(4_000)).toBe(refundedCents());
  });

  it("MUTATION (round 6, finding 2b): a slice marked made keeps its refund; an older row's unmarked slice never takes it", async () => {
    noteRows = new Set(["re_failed", "re_r2"]);
    coverByRefund.set("re_r2", 4_000);
    refunds = [refund("re_failed", 5, "failed", 4_000, 10), refund("re_r2", 6, "failed", 4_000, 12), refund("re_marked", 20), refund("re_s", 30)];
    rows = [
      row("op-own", "card_refund_failed_later_re_failed", 10),
      row("op-request", "refund_request_refund_request-1", 11, { failedRefundIds: ["re_r2"], madeRefundId: "re_marked" }),
    ];
    expect((await answered("re_marked")).failedRefundIds).toEqual(["re_r2"]);
    expect((await answered("re_s")).failedRefundIds).toEqual(["re_failed"]);
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION (round 6, finding 3): a re-send the owed figure gives no failure is noted by neither writer - one rule for both", async () => {
    // R1's row would send S at 20, but a dashboard refund at 15 filled its slice first: the dashboard refund answers R1.
    refunds.push(refund("re_dashboard", 15), refund("re_s", 20));
    expect(await answered("re_dashboard")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    // So S is the canonical delta's, by `charge.refunded` and the replay alike: R1's $40 and the canonical $40, for $80.
    expect((await answered("re_s")).ownNoted).toBe(false);
    expect(await xeroCoverAfterAsking(4_000)).toBe(refundedCents());
  });

  it("MUTATION (round 6, finding 4): a dashboard refund Stripe made before the failure, recorded after it, is never its answer", async () => {
    refunds.push(refund("re_dashboard_early", 8, "succeeded", 4_000, undefined, 15), refund("re_resent", 20));
    rows = [row("op-request", "refund_request_refund_request-1", 1, { failedRefundIds: ["re_failed"] })];
    expect((await answered("re_dashboard_early")).failedRefundIds).toEqual([]);
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
  });


  it("MUTATION: a row closed as Paid another way sent nothing: no refund answers its failure", async () => {
    refunds.push(refund("re_dashboard", 20));
    closes = [closeKeysOf("op-own")[0]!];
    expect((await answered("re_dashboard")).failedRefundIds).toEqual([]);
  });

  it("MUTATION: a failure with no note of its own is answered but not own-noted, and covers nothing", async () => {
    noteRows.clear();
    coverByRefund.clear();
    refunds.push(refund("re_resent", 20));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: false, coverCents: 0 });
  });

  it("MUTATION: a late capture's refund is its capture note's to size, and a refund no longer counted answers nothing", async () => {
    refunds.push(refund("re_resent", 20));
    lateCaptures.add("pi_card");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
    lateCaptures.clear();
    refunds[1] = refund("re_resent", 20, "failed");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
  });
});
