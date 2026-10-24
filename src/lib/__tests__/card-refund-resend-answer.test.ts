/**
 * #4312 round 7 (#4104, `INV-ADDPAY-045`): which refunds Stripe failed later a
 * card refund was sent again for (`readFailedRefundsAnsweredBy`) - by the
 * replay's own record alone: the slice it sent for them (a row of its own's
 * key, a re-planned slice's `failedRefundIds`), marked with the refund Stripe
 * made (`madeRefundId`), a failed re-send's chain included - and what their own
 * notes cover. A refund no slice is marked with answers nothing, whatever its
 * charge, amount or time. Each case also checks Xero's total against what went
 * back (`xeroCoverAfterAsking`). The real PostgreSQL proofs of each writer are
 * `xero-bt-card-refund-notes.realdb.test.ts`.
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

const PAYMENT = "payment-1";
const TXN = "txn-card";

/** Who made a refund: the recovery replay (`replay`), or the treasurer in the Stripe dashboard (`dashboard`). */
type Refund = { stripeRefundId: string; amountCents: number; status: string; stripePaymentIntentId: string | null; door: "replay" | "dashboard" };
type Row = { idempotencyKey: string; allocationPlan: unknown };

let refunds: Refund[];
let rows: Row[];
let noteRows: Set<string>;

function refund(id: string, status = "succeeded", door: Refund["door"] = "replay", amountCents = 4_000): Refund {
  return { stripeRefundId: id, amountCents, status, stripePaymentIntentId: "pi_card", door };
}

/** A card refund row with one $40 slice on the card charge. */
function row(idempotencyKey: string, slice: Record<string, unknown> = {}): Row {
  return { idempotencyKey, allocationPlan: [{ paymentTransactionId: TXN, amountCents: 4_000, ...slice }] };
}

/** A failed refund noted on its own record for `cents`. */
function noted(id: string, cents = 4_000) {
  noteRows.add(id);
  coverByRefund.set(id, cents);
}

const db = {
  paymentRefund: {
    findFirst: async ({ where }: { where: { stripeRefundId: string } }) => refunds.find((each) => each.stripeRefundId === where.stripeRefundId) ?? null,
  },
  paymentRecoveryOperation: { findMany: async () => rows },
  manualRefundTask: {},
  xeroSyncOperation: { count: async ({ where }: { where: { OR: Array<{ requestPayload?: { equals: string } }> } }) => (noteRows.has(where.OR[0]!.requestPayload!.equals) ? 1 : 0) },
  xeroObjectLink: {},
} as never;

const answered = (id: string) => readFailedRefundsAnsweredBy(db, PAYMENT, id);

/**
 * What Xero holds once every writer has asked: the failed refunds' own notes (`coverByRefund`), each dashboard
 * refund's own note in full, each re-send's own note where it answers an own-noted failure, at its amount less what
 * they cover (`readCardRefundNoteShare`), and `canonicalCents` for what the canonical note answers.
 */
async function xeroCoverAfterAsking(canonicalCents = 0): Promise<number> {
  let cents = canonicalCents + [...coverByRefund.values()].reduce((sum, each) => sum + each, 0);
  for (const each of refunds.filter((refund) => refund.status === "succeeded")) {
    if (each.door === "dashboard") {
      cents += each.amountCents;
      continue;
    }
    const answer = await answered(each.stripeRefundId);
    if (answer.ownNoted) cents += Math.max(0, each.amountCents - answer.coverCents);
  }
  return cents;
}

const refundedCents = () => refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amountCents, 0);

beforeEach(() => {
  lateCaptures.clear();
  coverByRefund.clear();
  noteRows = new Set();
  noted("re_failed");
  refunds = [refund("re_failed", "failed")];
  rows = [row("card_refund_failed_later_re_failed")];
});

describe("a card refund sent again for one Stripe failed later is paired by the replay's record (#4312 round 7)", () => {
  it("MUTATION: the refund its row's slice is marked with answers the failure, with the failed refund's own note; no other refund does", async () => {
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"), refund("re_same_amount_dashboard", "succeeded", "dashboard"), refund("re_other_amount", "succeeded", "dashboard", 1_000));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    for (const id of ["re_same_amount_dashboard", "re_other_amount"]) expect(await answered(id)).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION (finding 1): a dashboard refund made before the replay never takes the re-send's place - $80 in Xero for $80 refunded", async () => {
    // The treasurer refunds $40 in the dashboard while the row of its own still waits; then the replay sends its slice.
    refunds.push(refund("re_dashboard", "succeeded", "dashboard"));
    expect((await answered("re_dashboard")).failedRefundIds).toEqual([]);
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: true, coverCents: 4_000 });
    expect(await xeroCoverAfterAsking()).toBe(8_000);
    expect(refundedCents()).toBe(8_000);
  });

  it("before the replay marks its slice, its refund answers nothing; once marked, it answers - whoever recorded it first", async () => {
    refunds.push(refund("re_resent"));
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
  });

  it("MUTATION: two failures on one charge for one amount: each re-send answers the failure its own slice was sent for", async () => {
    noted("re_failed_2");
    refunds.push(refund("re_failed_2", "failed"), refund("re_resent_2"), refund("re_resent"));
    rows = [
      row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" }),
      row("card_refund_failed_later_re_failed_2", { madeRefundId: "re_resent_2" }),
    ];
    expect((await answered("re_resent")).failedRefundIds).toEqual(["re_failed"]);
    expect((await answered("re_resent_2")).failedRefundIds).toEqual(["re_failed_2"]);
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION: a re-planned slice's failures - every one of them - are answered by the refund it is marked with", async () => {
    rows = [row("refund_request_refund_request-1", { stripeKeySuffix: "refused2", failedRefundIds: ["re_failed", "re_failed_again"], madeRefundId: "re_resent" })];
    refunds.push(refund("re_failed_again", "failed"), refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed", "re_failed_again"], ownNoted: true, coverCents: 4_000 });
    expect(await xeroCoverAfterAsking()).toBe(refundedCents());
  });

  it("MUTATION (chain of three): a re-send Stripe failed too passes on what it answered, through the slice marked with it", async () => {
    // F0 is noted at $40. The request's row re-planned it and sent R1 (marked) and closed; Stripe failed R1, so a row of
    // its own sent R2 (marked) and closed; Stripe failed R2 too, and a row of its own sent R3.
    noteRows.clear();
    coverByRefund.clear();
    noted("re_f0");
    refunds = [refund("re_f0", "failed"), refund("re_r1", "failed"), refund("re_r2", "failed"), refund("re_r3")];
    rows = [
      row("refund_request_refund_request-1", { stripeKeySuffix: "refused1", failedRefundIds: ["re_f0"], madeRefundId: "re_r1" }),
      row("card_refund_failed_later_re_r1", { madeRefundId: "re_r2" }),
      row("card_refund_failed_later_re_r2", { madeRefundId: "re_r3" }),
    ];
    expect(await answered("re_r3")).toEqual({ failedRefundIds: ["re_r2", "re_r1", "re_f0"], ownNoted: true, coverCents: 4_000 });
    // R1 and R2 took no note (each answered by F0's), so Xero holds F0's $40 and nothing more: what went back.
    expect(await xeroCoverAfterAsking()).toBe(4_000);
    expect(refundedCents()).toBe(4_000);
  });

  it("MUTATION (finding 3): each failure's cover is counted for one refund only, however the chains meet", async () => {
    // Probe: a row of its own sent Z (marked) for F and closed; a dashboard refund X; Stripe failed Z, and a row of its
    // own owes Z, raised dead; a dashboard refund Y. Neither dashboard refund answers F, and Z no longer counts.
    refunds = [refund("re_failed", "failed"), refund("re_z", "failed"), refund("re_x", "succeeded", "dashboard"), refund("re_y", "succeeded", "dashboard")];
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_z" }), row("card_refund_failed_later_re_z")];
    const answers = await Promise.all(refunds.map((each) => answered(each.stripeRefundId)));
    expect(answers.map((each) => each.coverCents)).toEqual([0, 0, 0, 0]);
    // And where both rows sent again, each failure is reached through one refund only.
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_z" }), row("card_refund_failed_later_re_z", { madeRefundId: "re_w" })];
    refunds.push(refund("re_w"));
    const chains = await Promise.all(refunds.filter((each) => each.status === "succeeded").map((each) => answered(each.stripeRefundId)));
    const reached = chains.flatMap((each) => each.failedRefundIds);
    expect(reached.sort()).toEqual(["re_failed", "re_z"]);
    expect(chains.reduce((sum, each) => sum + each.coverCents, 0)).toBe(4_000);
  });

  it("MUTATION (lens probe): an open row's re-planned slice marked with its third send answers both failures; another row's unmarked slice answers nothing", async () => {
    noteRows.clear();
    coverByRefund.clear();
    noted("re_f1");
    noted("re_f9");
    refunds = [refund("re_f9", "failed"), refund("re_f1", "failed"), refund("re_f2", "failed"), refund("re_r3"), refund("re_r9")];
    rows = [
      row("refund_request_refund_request-A", { stripeKeySuffix: "refused2", failedRefundIds: ["re_f1", "re_f2"], madeRefundId: "re_r3" }),
      row("refund_request_refund_request-C", { stripeKeySuffix: "refused1", failedRefundIds: ["re_f9"] }),
    ];
    expect((await answered("re_r3")).failedRefundIds).toEqual(["re_f1", "re_f2"]);
    expect((await answered("re_r9")).failedRefundIds).toEqual([]);
  });

  it("STATED LIMIT: a dashboard refund is never paired, even one settling a row raised dead - the replay's record is the only link", async () => {
    refunds = [refund("re_failed", "failed"), refund("re_dashboard", "succeeded", "dashboard")];
    rows = [row("card_refund_failed_later_re_failed")];
    expect(await answered("re_dashboard")).toEqual({ failedRefundIds: [], ownNoted: false, coverCents: 0 });
  });

  it("a slice made with no failure behind it - an inline refund, say - answers nothing", async () => {
    rows = [row("refund_request_refund_request-1", { madeRefundId: "re_inline" })];
    refunds.push(refund("re_inline"));
    expect((await answered("re_inline")).failedRefundIds).toEqual([]);
  });

  it("MUTATION: a failure with no note of its own is answered but not own-noted, and covers nothing", async () => {
    noteRows.clear();
    coverByRefund.clear();
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    expect(await answered("re_resent")).toEqual({ failedRefundIds: ["re_failed"], ownNoted: false, coverCents: 0 });
    // Its failure folded into the canonical note, which answers it: $40 for $40.
    expect(await xeroCoverAfterAsking(4_000)).toBe(refundedCents());
  });

  it("MUTATION: a late capture's refund is its capture note's to size, and a refund no longer counted answers nothing", async () => {
    rows = [row("card_refund_failed_later_re_failed", { madeRefundId: "re_resent" })];
    refunds.push(refund("re_resent"));
    lateCaptures.add("pi_card");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
    lateCaptures.clear();
    refunds[1] = refund("re_resent", "failed");
    expect((await answered("re_resent")).failedRefundIds).toEqual([]);
  });
});
