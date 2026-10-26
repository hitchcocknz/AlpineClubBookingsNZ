import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

import { parseWorkflowYaml } from "./check-workflow-suite-checkout-depth.mjs";
import {
  EXPECTED_SHARD_COUNT,
  classifyTestShardJobs,
  getAttemptJobs,
  parseShardGateArgs,
  requireTestShards,
} from "./require-test-shards.mjs";

const root = path.resolve(import.meta.dirname, "..", "..");
const workflow = parseWorkflowYaml(
  readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8"),
);

function shard(index, status = "completed", conclusion = "success") {
  return { name: `Test shard (${index}/${EXPECTED_SHARD_COUNT})`, status, conclusion };
}

const passed = () => Array.from({ length: EXPECTED_SHARD_COUNT }, (_, i) => shard(i + 1));

describe("required verify's independent test-shard gate", () => {
  it("preserves the required job name, avoids needs/job-level if, and gives every shard a full checkout", () => {
    const verify = workflow.jobs.verify;
    const matrixJob = workflow.jobs["test-shard"];
    expect(verify.needs).toBeUndefined();
    expect(verify.if).toBeUndefined();
    expect(verify["continue-on-error"]).toBeUndefined();
    expect(verify.permissions.actions).toBe("read");
    expect(verify.permissions.contents).toBe("read");
    const gateStep = verify.steps.find((step) => step.run === "node scripts/ci/require-test-shards.mjs");
    expect(gateStep).toBeDefined();
    expect(gateStep?.if).toBeUndefined();
    expect(gateStep?.["continue-on-error"]).toBeUndefined();
    expect(verify.steps.some((step) => /(?:^|\s)p?npm test(?:\s|$)/.test(step.run ?? ""))).toBe(false);
    expect(matrixJob.if).toBeUndefined();
    expect(matrixJob["continue-on-error"]).toBeUndefined();
    // Both jobs run the suite/build under one effective test environment.
    // The pre-install workflow parser cannot expand YAML aliases, and a
    // workflow-wide env would reach unrelated jobs, so pin complete equality.
    expect(matrixJob.env).toEqual(verify.env);
    expect(matrixJob.strategy["fail-fast"]).toBe("false");
    expect(matrixJob.strategy.matrix.shard.map(Number)).toEqual([1, 2, 3, 4]);
    expect(matrixJob.strategy.matrix.shard).toHaveLength(EXPECTED_SHARD_COUNT);
    expect(matrixJob.name).toBe(`Test shard (${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT})`);
    expect(matrixJob.steps.find((step) => step.uses?.startsWith("actions/checkout"))?.with?.["fetch-depth"]).toBe("0");
    const testStep = matrixJob.steps.find((step) => step.run === `pnpm test --shard=${"${{ matrix.shard }}"}/${EXPECTED_SHARD_COUNT}`);
    expect(testStep).toBeDefined();
    expect(testStep?.if).toBeUndefined();
    expect(testStep?.["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs.verify.steps.at(-1).name).toBe("File-size budget ratchet");
  });

  it("requires all expected successes, never accepting a partial or duplicate matrix", () => {
    expect(classifyTestShardJobs(passed())).toEqual([]);
    expect(classifyTestShardJobs(passed().slice(0, -1))).toEqual(["missing 4/4"]);
    expect(() => classifyTestShardJobs([...passed(), shard(1)])).toThrow(/Duplicate/);
    expect(() => classifyTestShardJobs([...passed(), { ...shard(1), name: "Test shard (5/4)" }])).toThrow(/Unexpected/);
    expect(() => classifyTestShardJobs([...passed(), { ...shard(1), name: "Test shard (1/3)" }])).toThrow(/Unexpected/);
  });

  it.each(["failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", null])(
    "fails closed on a completed %s conclusion",
    (conclusion) => {
      const jobs = passed();
      jobs[2] = shard(3, "completed", conclusion);
      expect(() => classifyTestShardJobs(jobs)).toThrow(/Test shard 3\/4 completed as/);
    },
  );

  it("waits for not-yet-created and running shards, then accepts the complete attempt", async () => {
    let calls = 0;
    await expect(requireTestShards({
      loadJobs: async () => {
        calls += 1;
        if (calls === 1) return [];
        if (calls === 2) return [shard(1, "in_progress", null), ...passed().slice(1)];
        return passed();
      },
      sleep: async () => {},
    })).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("times out when a shard never appears or finishes", async () => {
    let clock = 0;
    await expect(requireTestShards({
      loadJobs: async () => passed().slice(0, -1),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxWaitMs: 20,
      intervalMs: 10,
    })).rejects.toThrow(/Timed out.*missing 4\/4/);
  });

  it("fails closed on an API/auth error without treating it as an empty successful run", async () => {
    await expect(requireTestShards({ loadJobs: async () => { throw new Error("HTTP 403"); } }))
      .rejects.toThrow(/HTTP 403/);
  });
});

describe("attempt-scoped GitHub jobs read", () => {
  const options = {
    apiUrl: "https://api.github.com",
    repository: "club/repo",
    runId: "123",
    attempt: "2",
    token: "test-token",
  };

  it("reads every page of this run attempt, never a previous attempt", async () => {
    const urls = [];
    const fetchImpl = async (url, request) => {
      urls.push(url.toString());
      expect(request.headers.Authorization).toBe("Bearer test-token");
      const page = Number(url.searchParams.get("page"));
      return { ok: true, json: async () => ({ total_count: 101, jobs: page === 1 ? Array(100).fill({ name: "other" }) : [shard(1)] }) };
    };
    expect(await getAttemptJobs({ ...options, fetchImpl })).toHaveLength(101);
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes("/runs/123/attempts/2/jobs?"))).toBe(true);
  });

  it("rejects missing credentials, HTTP errors, malformed lists and short pages", async () => {
    await expect(getAttemptJobs({ ...options, token: "" })).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: false, status: 403 }) })).rejects.toThrow(/HTTP 403/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ jobs: null }) }) })).rejects.toThrow(/invalid job list/);
    await expect(getAttemptJobs({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ total_count: 1, jobs: [] }) }) })).rejects.toThrow(/incomplete page/);
  });
});

it("the CLI fails closed without a GitHub run identity", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "ci", "require-test-shards.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REPOSITORY: "", GITHUB_TOKEN: "" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Shard gate for "Test shard" failed');
});

// #4397: e2e.yml's required jobs reuse this gate for their own matrices.
describe("the gate for another matrix (--label/--count)", () => {
  const e2e = (index, status = "completed", conclusion = "success") => ({ name: `E2E shard (${index}/3)`, status, conclusion });

  it("parses its arguments, defaulting to the unit-test matrix, and refuses anything else", () => {
    expect(parseShardGateArgs([])).toEqual({ label: "Test shard", count: EXPECTED_SHARD_COUNT, maxWaitMs: 45 * 60_000, upstream: [] });
    expect(parseShardGateArgs(["--label", "E2E shard", "--count", "3", "--max-wait-minutes", "55"])).toEqual({ label: "E2E shard", count: 3, maxWaitMs: 55 * 60_000, upstream: [] });
    expect(() => parseShardGateArgs(["--count", "0"])).toThrow(/Invalid --count/);
    expect(() => parseShardGateArgs(["--label", "x\"; rm"])).toThrow(/Invalid --label/);
    expect(() => parseShardGateArgs(["--label"])).toThrow(/needs a value/);
    expect(() => parseShardGateArgs(["--shards", "3"])).toThrow(/Unknown argument/);
  });

  it("counts only its own label's jobs, and fails closed on a skipped, cancelled, missing or duplicate one", () => {
    const unitShard = { name: "Test shard (1/4)", status: "in_progress", conclusion: null };
    expect(classifyTestShardJobs([e2e(1), e2e(2), e2e(3), unitShard], 3, "E2E shard")).toEqual([]);
    expect(classifyTestShardJobs([e2e(1), e2e(3, "queued", null)], 3, "E2E shard")).toEqual(["missing 2/3", "3/3 queued"]);
    expect(() => classifyTestShardJobs([e2e(1), e2e(2, "completed", "skipped"), e2e(3)], 3, "E2E shard")).toThrow(/E2E shard 2\/3 completed as skipped/);
    expect(() => classifyTestShardJobs([e2e(1, "completed", "cancelled")], 3, "E2E shard")).toThrow(/completed as cancelled/);
    expect(() => classifyTestShardJobs([e2e(1), e2e(1)], 3, "E2E shard")).toThrow(/Duplicate E2E shard/);
    expect(() => classifyTestShardJobs([{ name: "E2E shard (1/4)", status: "completed", conclusion: "success" }], 3, "E2E shard")).toThrow(/Unexpected E2E shard/);
  });

  it("fails at once when a named upstream job fails, instead of waiting out runners that will never expand", () => {
    // What GitHub reported in run 40247244343 for the skipped matrix.
    const placeholder = { name: "matrix.name", status: "completed", conclusion: "cancelled" };
    const image = (conclusion, status = "completed") => ({ name: "E2E app image", status, conclusion });
    const upstream = ["E2E app image", "E2E seeded database"];
    expect(() => classifyTestShardJobs([image("failure"), placeholder], 3, "E2E shard", upstream)).toThrow(/Upstream job "E2E app image" completed as failure/);
    expect(() => classifyTestShardJobs([image("cancelled")], 1, "E2E multi-lodge run", upstream)).toThrow(/completed as cancelled/);
    // Still running or passed upstream: just pending.
    expect(classifyTestShardJobs([image(null, "in_progress"), placeholder], 1, "E2E multi-lodge run", upstream)).toEqual(["missing 1/1"]);
    expect(classifyTestShardJobs([image("success")], 1, "E2E multi-lodge run", upstream)).toEqual(["missing 1/1"]);
    expect(parseShardGateArgs(["--upstream", "E2E app image", "--upstream", "E2E seeded database"]).upstream).toEqual(upstream);
  });

  it("names the matrix in a timeout", async () => {
    let clock = 0;
    await expect(requireTestShards({
      loadJobs: async () => [e2e(1)],
      count: 3,
      label: "E2E shard",
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      maxWaitMs: 30_000,
      intervalMs: 15_000,
    })).rejects.toThrow(/Timed out waiting for E2E shard jobs: missing 2\/3, missing 3\/3/);
  });
});

describe("Vitest shard partition on the actual repository", () => {
  function listFiles() {
    const result = spawnSync(process.execPath, [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "list", "--filesOnly", "--json",
    ], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DATABASE_URL: "postgresql://codex:codex@127.0.0.1:5432/codex_local" },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout).map((entry) => path.relative(root, entry.file).replaceAll("\\", "/"));
  }

  it("assigns every file exactly once using Vitest's actual run sequencer", async () => {
    const all = listFiles();
    // `vitest list --shard` does not apply sharding in Vitest 5: only the RUN
    // path invokes BaseSequencer.shard. Feed the real discovered files to that
    // exact implementation instead of testing an ignored list flag.
    const parts = await Promise.all(Array.from({ length: EXPECTED_SHARD_COUNT }, async (_, i) => {
      const sequencer = new BaseSequencer({
        config: { root, shard: { index: i + 1, count: EXPECTED_SHARD_COUNT } },
      });
      const assigned = await sequencer.shard(all.map((file) => ({ moduleId: path.join(root, file) })));
      return assigned.map((spec) => path.relative(root, spec.moduleId).replaceAll("\\", "/"));
    }));
    const assigned = parts.flat();
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.toSorted()).toEqual(all.toSorted());
    for (const file of [
      "src/lib/__tests__/frozen-test-clock.test.ts",
      "src/lib/__tests__/frozen-test-clock-opt-out.test.ts",
      "scripts/ci/check-workflow-suite-checkout-depth.test.mjs",
      "src/lib/__tests__/typecheck-project-coverage.test.ts",
    ]) {
      expect(assigned.filter((entry) => entry === file)).toHaveLength(1);
    }
  });
});

// #4397: e2e.yml's two required checks are gates over runner jobs, pinned the
// way `verify` is above. A change that lets one go green without its runners
// passing must fail here, not on a merged pull request.
describe("e2e.yml's required gates and their runners", () => {
  const e2e = parseWorkflowYaml(readFileSync(path.join(root, ".github", "workflows", "e2e.yml"), "utf8"));
  const e2eText = readFileSync(path.join(root, ".github", "workflows", "e2e.yml"), "utf8");
  const runner = e2e.jobs["e2e-runner"];
  const entries = runner.strategy.matrix.include;
  const gates = [
    { id: "playwright", name: "Playwright E2E", label: "E2E shard" },
    { id: "multi-lodge", name: "E2E multi-lodge", label: "E2E multi-lodge run" },
  ];

  it.each(gates)("$name keeps its required name, has no needs/if, and gates exactly its matrix entries", ({ id, name, label }) => {
    const gate = e2e.jobs[id];
    expect(gate.name).toBe(name);
    expect(gate.needs).toBeUndefined();
    expect(gate.if).toBeUndefined();
    expect(gate["continue-on-error"]).toBeUndefined();
    expect(gate.permissions.actions).toBe("read");
    const gateStep = gate.steps.find((step) => step.run?.startsWith("node scripts/ci/require-test-shards.mjs"));
    expect(gateStep?.if).toBeUndefined();
    expect(gateStep?.["continue-on-error"]).toBeUndefined();
    const options = parseShardGateArgs(gateStep.run.replace("node scripts/ci/require-test-shards.mjs", "").match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, "")));
    expect(options.label).toBe(label);
    // Fails at once on exactly the jobs the runners need.
    expect(options.upstream).toEqual(runner.needs.replace(/[[\]]/g, "").split(",").map((id) => e2e.jobs[id.trim()].name));
    const mine = entries.filter((entry) => entry.name.startsWith(`${label} (`));
    expect(mine).toHaveLength(options.count);
    expect(mine.map((entry) => entry.name)).toEqual(Array.from({ length: options.count }, (_, i) => `${label} (${i + 1}/${options.count})`));
    // The gate outwaits the slowest chain it depends on (image, then a runner).
    expect(options.maxWaitMs / 60_000).toBeGreaterThanOrEqual(Number(e2e.jobs["e2e-image"]["timeout-minutes"]) + Number(runner["timeout-minutes"]));
    expect(Number(gate["timeout-minutes"])).toBeGreaterThan(options.maxWaitMs / 60_000);
  });

  it("runs every matrix entry as its own runner, each shard on its own slice", () => {
    expect(runner.name).toBe("${{ matrix.name }}");
    expect(runner.if).toBeUndefined();
    expect(runner["continue-on-error"]).toBeUndefined();
    expect(runner.env.E2E_MULTI_LODGE).toBe("${{ matrix.multi_lodge }}");
    // The runner cannot pass without actually preparing the stack and running
    // Playwright: the steps exist, run exactly these commands, and neither can
    // be skipped by anything but an explicit needed=false, nor shrug off a failure.
    const needed = "steps.scope.outputs.needed != 'false'";
    const scope = runner.steps.find((step) => step.id === "scope");
    expect(scope?.run).toBe("node scripts/ci/e2e-scope.mjs");
    expect(scope?.if).toBeUndefined();
    for (const command of ["bash scripts/e2e-stack.sh prepare", "bash scripts/e2e-stack.sh run ${{ matrix.playwright_args }}"]) {
      const step = runner.steps.find((item) => item.run === command);
      expect(step, command).toBeDefined();
      expect(step.if).toBe(needed);
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(runner.strategy["fail-fast"]).toBe("false");
    expect(runner.env.E2E_SHARD).toBe("${{ matrix.shard }}");
    for (const entry of entries.filter((item) => item.name.startsWith("E2E shard ("))) {
      expect(entry.name).toBe(`E2E shard (${entry.shard})`);
      expect(entry.multi_lodge).toBe("");
      // No extra Playwright arguments: `--list`, a never-matching `--grep` or a
      // narrower `--project` would let a shard pass without running its slice.
      expect(entry.playwright_args).toBe("");
    }
    expect(entries).toHaveLength(4);
    const multiLodge = entries.filter((item) => item.multi_lodge === "1");
    expect(multiLodge).toEqual([expect.objectContaining({ name: "E2E multi-lodge run (1/1)", shard: "", playwright_args: "--project=multi-lodge" })]);
  });


  it("skips heavy steps only on an explicit needed=false, never on a missing answer", () => {
    expect(e2eText).not.toMatch(/outputs\.needed == 'true'/);
    for (const job of Object.values(e2e.jobs)) {
      for (const step of job.steps) {
        if (step.if?.includes("steps.scope")) expect(step.if).toMatch(/steps\.scope\.outputs\.needed != 'false'/);
      }
    }
  });

  it("keeps every secret out of the seeded-database artifact", () => {
    const dbJob = e2eText.slice(e2eText.indexOf("\n  e2e-db:"), e2eText.indexOf("\n  e2e-runner:"));
    expect(dbJob).toContain("bash scripts/e2e-stack.sh snapshot");
    expect(JSON.stringify(e2e.jobs["e2e-db"])).not.toMatch(/\bsecrets\b/);
    // Nothing workflow-wide reaches the job either.
    expect(e2e.env).toBeUndefined();
    const stack = readFileSync(path.join(root, "scripts", "e2e-stack.sh"), "utf8");
    const body = (name) => stack.slice(stack.indexOf(`\n${name}() {`), stack.indexOf("\n}\n", stack.indexOf(`\n${name}() {`)));
    for (const name of ["seed_database", "snapshot", "reset_database", "capture_fixture_date"]) {
      expect(stack.indexOf(`\n${name}() {`), `${name}() must exist`).toBeGreaterThan(-1);
      expect(body(name), name).not.toMatch(/seed-stripe-credentials|STRIPE/);
    }
    // Every shell function `snapshot` calls is one of those checked above.
    const called = [...body("snapshot").matchAll(/^\s*([a-z_]+)(?:\s|$)/gm)].map((match) => match[1]);
    const checkedOrBuiltin = new Set(["seed_database", "reset_database", "capture_fixture_date", "local", "echo", "mkdir", "compose", "cp", "snapshot"]);
    expect(called.filter((name) => !checkedOrBuiltin.has(name))).toEqual([]);
    expect(stack.slice(stack.indexOf("prepare() {"))).toContain("e2e/setup/seed-stripe-credentials.ts");
  });
});
