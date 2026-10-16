import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4189: the PostgreSQL proof that a range-mode direct edit keeps a gapped
 * guest's nights self-skips without `RUN_CONCURRENCY_RACE_TESTS`, and hosted CI
 * reaches it only through the race harness's import. Lose the import and the
 * proof silently stops running.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the direct-edit repeated-range proof stays wired into CI (#4189)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"),
      "utf8",
    );
    expect(harness).toContain('import "./booking-direct-edit-repeated-range.realdb.test";');
    const suite = readFileSync(
      resolve(REPO_ROOT, "src/lib/__tests__/booking-direct-edit-repeated-range.realdb.test.ts"),
      "utf8",
    );
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("the gapped guests keep their nights byte for byte");
    expect(suite).toContain("the repeated gapped guest keeps their nights, the moved one is re-spread");
  });
});
