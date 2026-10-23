import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #3953: the PostgreSQL proof that a change's card capture gets one Xero
 * receipt self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI
 * reaches it only through the race harness's import. Lose the import and the
 * proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the change capture receipt proof stays wired into CI (#3953)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./additional-capture-receipt.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/additional-capture-receipt.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the webhook and the confirm route at once, then a replay, queue one receipt");
    expect(suite).toContain("many enqueues at once make one row");
    expect(suite).toContain("queues behind a session holding the change's supplementary-invoice anchor lock");
    expect(suite).toContain("is recorded once, by its receipt, where the figures say the primary's cash did not cover it");
    expect(suite).toContain("is recorded once, by the gap invoice that names it, where the figures cannot say");
  });
});
