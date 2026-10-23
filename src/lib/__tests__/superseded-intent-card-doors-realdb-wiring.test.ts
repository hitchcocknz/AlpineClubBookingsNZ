import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4300 (`INV-PAY-043`): the real-PostgreSQL proof that a superseded card
 * intent never settles a booking through any door self-skips without
 * `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI reaches it only because the race
 * harness imports it. Lose that import and the proof silently becomes a no-op
 * while every suite stays green - so the edge is pinned here, as
 * `third-duplicate-capture-realdb-wiring.test.ts` pins #4211's.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the superseded-intent card-doors real-database proof stays wired into CI (#4300)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./superseded-intent-card-doors.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/superseded-intent-card-doors.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    for (const door of [
      "the confirm door: Stripe was down for the edit's cancel",
      "the confirm door after the webhook already handed the capture to its refund",
      "the webhook after the cancel worker's retry lost to the capture",
      "the pay step's reload, holding the superseded capture",
      "the /pay link's reload, holding the superseded capture",
    ]) {
      expect(suite).toContain(door);
    }
  });
});
