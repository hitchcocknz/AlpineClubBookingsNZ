import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4290 (`INV-ADDPAY-043`): the real-PostgreSQL proof that a bank-transfer
 * group joiner's refund is held by the #4162 floor self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `ledger-insertion-seq-realdb-wiring.test.ts` pins #4132's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bank-transfer group joiner refund-detail real-database proof stays wired into CI (#4290)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./bt-joiner-refund-detail.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/bt-joiner-refund-detail.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("Xero voids the joiner's note; the recount keeps the refund");
    expect(suite).toContain("a live note for less than the joiner's refund");
    expect(suite).toContain("a later refund on the joiner's payment is never recorded there");
  });
});
