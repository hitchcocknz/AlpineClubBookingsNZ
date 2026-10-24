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

type Refund = { stripeRefundId: string; paymentTransactionId: string | null; stripePaymentIntentId: string | null; amountCents: number; status: string; createdAt: Date; updatedAt: Date };
type Row = { id: string; idempotencyKey: string; allocationPlan: unknown };

let refunds: Refund[];
let rows: Row[];
let closes: string[];
let noteRows: Set<string>;

/** A refund the ledger recorded at `seconds`; a failed one failed at `failedSeconds` (its row's last write), else then. */
function refund(id: string, seconds: number, status = "succeeded", amountCents = 4_000, failedSeconds = seconds): Refund {
  return { stripeRefundId: id, paymentTransactionId: TXN, stripePaymentIntentId: "pi_card", amountCents, status, createdAt: at(seconds), updatedAt: at(failedSeconds) };
}

const db = {
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

beforeEach(() => {
  lateCaptures.clear();
  coverByRefund.clear();
  noteRows = new Set(["re_failed"]);
  coverByRefund.set("re_failed", 4_000);
  closes = [];
  refunds = [refund("re_failed", 5, "failed", 4_000, 10)];
  rows = [{ id: "op-own", idempotencyKey: "card_refund_failed_later_re_failed", allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000 }] }];
});

describe("a card refund sent again for one Stripe failed later (#4312 round 5)", () => {
  it("MUTATION: the first refund recorded after the failure, on its charge for its amount, answers it - with the failed refund's own note", async () => {
    refunds.push(refund("re_before", 8), refund("re_other_amount", 15, "succeeded", 1_000), refund("re_resent", 20), refund("re_later", 30));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    // One refund answers it: a later one of the same amount, an earlier one, another amount - none.
    for (const id of ["re_later", "re_before", "re_other_amount"]) expect(await answered(id)).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
  });

  it("MUTATION: two failures on one charge for one amount: each re-send answers its own, in turn", async () => {
    rows.push({ id: "op-own-2", idempotencyKey: "card_refund_failed_later_re_failed_2", allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000 }] });
    noteRows.add("re_failed_2");
    coverByRefund.set("re_failed_2", 4_000);
    // The second was made before the first failed, and failed after it: never the first one's re-send.
    refunds.push(refund("re_failed_2", 7, "failed", 4_000, 12), refund("re_resent", 20), refund("re_resent_2", 30));
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
    expect((await answered("re_resent_2")).failedRefundIds).toEqual(["re_failed_2"]);
  });

  it("MUTATION: a re-planned slice's failures - every one of them - are answered by the refund made after the latest", async () => {
    rows = [{
      id: "op-request", idempotencyKey: "refund_request_refund_request-1",
      allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000, stripeKeySuffix: "refused2", failedRefundIds: ["re_failed", "re_failed_again"] }],
    }];
    refunds.push(refund("re_failed_again", 20, "failed", 4_000, 25), refund("re_resent", 30));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed", "re_failed_again"], ownNoted: true, coverCents: 4_000 });
  });

  it("MUTATION: a slice marked made answers with that refund only", async () => {
    rows[0]!.allocationPlan = [{ paymentTransactionId: TXN, amountCents: 4_000, madeRefundId: "re_marked" }];
    refunds.push(refund("re_first", 20), refund("re_marked", 30));
    expect((await answered("re_marked")).failedRefundIds).toEqual(["re_failed"]);
    expect((await answered("re_first")).failedRefundIds).toEqual([]);
  });

  it("a refund sent again that failed too still takes the slice: the next one does not answer the first failure", async () => {
    refunds.push(refund("re_resent_failed", 20, "failed", 4_000, 25), refund("re_dashboard", 30));
    expect((await answered("re_dashboard")).failedRefundIds).toEqual([]);
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
