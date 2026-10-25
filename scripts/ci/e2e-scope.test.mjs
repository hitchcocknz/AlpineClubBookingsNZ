import { decide, e2eNeeded, pullRequestChangedFiles } from "./e2e-scope.mjs";

describe("e2e-scope: which pull requests the browser suite can skip (#4397)", () => {
  it.each([
    [["docs/E2E_PLAYWRIGHT.md"]],
    [["AGENTS.md", "docs/agents/COORDINATION.md", "changelog.d/4397-fast-e2e.md"]],
    [["src/lib/__tests__/payment.realdb.test.ts", "docs/STATE_MACHINES.md"]],
    [["src/components/booking/Thing.test.tsx"]],
    [["scripts/ci/e2e-scope.test.mjs"]],
    [[".claude/agents/reviewer.md", ".github/pull_request_template.md", ".gitleaksignore"]],
    [["dependency-mitigations.d/1-x.json", "size-allowances.d/1-x.md"]],
  ])("skips a change that cannot reach the suite: %j", (files) => {
    expect(e2eNeeded(files).needed).toBe(false);
  });

  it.each([
    [["src/lib/payment-reconciliation.ts"]],
    [["docs/README.md", "src/app/page.tsx"]],
    [["e2e/waitlist.spec.ts"]],
    [["e2e/README.md"]],
    [["prisma/schema.prisma"]],
    [["prisma/demo-seed.ts"]],
    [["scripts/e2e-stack.sh"]],
    [["scripts/ci/e2e-scope.mjs"]],
    [[".github/workflows/e2e.yml"]],
    [["package.json"]],
    [["pnpm-lock.yaml"]],
    [["Dockerfile"]],
    [["docker-compose.staging.yml"]],
    [["playwright.config.ts"]],
    [["vitest.setup.ts"]],
    [["src/lib/__tests__helpers.ts"]],
    [["public/robots.txt"]],
  ])("runs the suite for a change that can reach it: %j", (files) => {
    expect(e2eNeeded(files).needed).toBe(true);
  });

  it("runs the suite when the change list is empty or missing", () => {
    expect(e2eNeeded([]).needed).toBe(true);
    expect(e2eNeeded(undefined).needed).toBe(true);
  });

  it("always runs on a push, and on any failure to list the change", () => {
    expect(decide("push", () => ["docs/a.md"]).needed).toBe(true);
    expect(decide("pull_request", () => ["docs/a.md"]).needed).toBe(false);
    expect(decide("pull_request", () => { throw new Error("shallow clone"); }).needed).toBe(true);
  });

  it("diffs the merge commit against its base parent, and refuses a non-merge HEAD", () => {
    const calls = [];
    const files = pullRequestChangedFiles((args) => {
      calls.push(args.join(" "));
      return args[0] === "rev-list" ? "merge base head\n" : "docs/a.md\nsrc/b.ts\n";
    });
    expect(files).toEqual(["docs/a.md", "src/b.ts"]);
    expect(calls[1]).toBe("diff --name-only --no-renames HEAD^1 HEAD");
    expect(() => pullRequestChangedFiles(() => "only-one-commit parent\n")).toThrow(/two-parent merge/);
  });
});
