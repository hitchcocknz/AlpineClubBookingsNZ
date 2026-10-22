import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #4230 (`INV-ADDPAY-021`, `INV-PAY-124`): the real-PostgreSQL pins that a
 * group organiser's hand-back leaves the bank-transfer recount nothing to drop,
 * that the recount never writes the charge rows the #4162 floor keeps, of the
 * absorbed later refunds and the alert they raise, and of the deploy note's query,
 * self-skip without `RUN_CONCURRENCY_RACE_TESTS`; hosted CI reaches them only
 * because the race harness imports them. Lose that import and they silently
 * become a no-op while every suite stays green, so the edge is pinned here.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

describe("the bank-transfer recount hand-back pins stay wired into CI (#4230)", () => {
  it("is imported by the race harness CI runs against a real database", () => {
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./xero-bt-recount-handbacks.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/xero-bt-recount-handbacks.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("a group organiser's hand-back moves no payment's refunded total");
    expect(suite).toContain("the recount writes the payment's refunded total and never its charge rows");
    expect(suite).toContain("CURRENT BEHAVIOUR: a second cancellation hand-back is absorbed into the canonical note");
    expect(suite).toContain("CURRENT BEHAVIOUR: a refund request's card part on a bank transfer is absorbed");
    expect(suite).toContain("a payment whose refunds all have notes is not listed by the deploy note's query");
    expect(suite).toContain("a review's refund on a cancelled booking counts with its own note");
    expect(suite).toContain("a void the nightly follow-up undid is not listed");
    expect(suite).toContain("which void states reach the alert");
  });
});
