import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4320 (`INV-PAY-045`): the real-PostgreSQL proof that a manual mark-paid's
 * reversal withdraws the cancellations the mark-paid queued (one a Stripe
 * outage left FAILED and retrying included) and leaves an edit's earlier
 * cancellation alone self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and
 * hosted CI reaches it only because the race harness imports it. Lose that
 * import and the proof silently becomes a no-op while every suite stays green -
 * so the edge is pinned here, as `superseded-intent-card-doors-realdb-wiring.test.ts`
 * pins #4300's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("INV-PAY-045: the mark-paid reversal's retrying-cancel real-database proof stays wired into CI (#4320)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./manual-reversal-retrying-cancel.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/manual-reversal-retrying-cancel.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const scenario of [
      "the mark-paid's own cancel, FAILED and retrying, is withdrawn: the member's capture of that intent settles the booking",
      "the mark-paid's own cancel, FAILED and retrying, is withdrawn: a later worker run cancels nothing",
      "the mark-paid's own cancel, exhausted at the ceiling, is withdrawn too",
      "an edit's cancel the mark-paid found waiting (FAILED, retrying) outlives the reversal",
      "an edit's cancel the mark-paid found waiting outlives the reversal: the old tab's capture is refunded",
    ]) {
      expect(suite).toContain(scenario);
    }
  });
});
