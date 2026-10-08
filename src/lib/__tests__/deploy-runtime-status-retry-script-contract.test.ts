import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bashFixturePath, bashGateArgs } from "@/lib/__tests__/helpers/bash-fixture-path";
import { readRepoFile } from "@/lib/__tests__/helpers/compose";

/**
 * The pre-cutover runtime-status read in the deploy script, RUN rather than
 * grepped (#3965).
 *
 * Step 15 of a real deploy died with nothing printed between the step header and
 * "Blue/green deployment failed.", on the read of `/api/deploy/runtime-status`
 * that runs straight after the container reports healthy; a hand check moments
 * later passed. The fix retries that read for a bounded time and, when it gives
 * up, prints the last HTTP status and body.
 *
 * Retry behaviour is exactly what a source-text assertion cannot prove, so this
 * suite lifts the two shell functions out of the script and runs them under the
 * script's own `set -Eeuo pipefail` and an ERR trap. Only `docker` and `sleep`
 * are stubbed: the `docker compose exec` stub runs the in-container `/bin/sh`
 * script for real, with the real `node` client, against an HTTP server in this
 * process — so the status-and-body protocol between the container and the host
 * is exercised end to end, not modelled. The only rewrite is the loopback port,
 * `3000` in the container, an ephemeral one here.
 *
 * `test:related` cannot select this file: it reads the shell script from disk,
 * so it has no import edge to it (`docs/TESTING.md`).
 */

const SCRIPT = readRepoFile("scripts/run-production-blue-green-deploy.sh");
const SECRET = "test-cron-secret-not-real";
const RUN_TIMEOUT_MS = 30_000;

function functionSource(name: string): string {
  const start = SCRIPT.indexOf(`\n${name}() {`);
  expect(start, `${name} must be defined in the deploy script`).toBeGreaterThan(0);
  const end = SCRIPT.indexOf("\n}\n", start);
  expect(end, `${name} must have a closing brace`).toBeGreaterThan(start);
  return SCRIPT.slice(start + 1, end + 3);
}

function noSecretExitAssignment(): string {
  const match = SCRIPT.match(/^RUNTIME_STATUS_NO_SECRET_EXIT=\d+$/m);
  expect(match, "RUNTIME_STATUS_NO_SECRET_EXIT must be assigned in the deploy script").not.toBeNull();
  return match![0];
}

const fixtureDir = mkdtempSync(path.join(tmpdir(), "runtime-status-retry-"));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function writeHarness(): string {
  const harness = [
    "set -Eeuo pipefail",
    // The deploy script's own trap is `fail`, which prints the failure banner.
    // A failed ATTEMPT must never reach it; only the give-up may.
    `trap 'echo "ERR-TRAP-FIRED" >&2' ERR`,
    `DEPLOY_RUNTIME_STATUS_PATH="/api/deploy/runtime-status"`,
    `RUNTIME_STATUS_TIMEOUT_SECONDS="$STUB_TIMEOUT"`,
    noSecretExitAssignment(),
    functionSource("read_service_runtime_status_once"),
    functionSource("get_service_runtime_payload"),
    "sleep() { :; }",
    "docker() {",
    '  if [ "$1 $2 $3" != "compose exec -T" ] || [ "$5" != "/bin/sh" ] || [ "$6" != "-c" ]; then',
    '    echo "unexpected docker call: $*" >&2',
    "    return 99",
    "  fi",
    '  local container_script="${7//127.0.0.1:3000/127.0.0.1:$STUB_PORT}"',
    "  shift 7",
    '  CRON_SECRET="$STUB_CRON_SECRET" PATH="$STUB_NODE_DIR:$PATH" /bin/sh -c "$container_script" "$@"',
    "}",
    'payload="$(get_service_runtime_payload app)"',
    "printf 'PAYLOAD=%s\\n' \"$payload\"",
    "",
  ].join("\n");
  const harnessPath = path.join(fixtureDir, "harness.sh");
  writeFileSync(harnessPath, harness, "utf8");
  return harnessPath;
}

type Responder = (hit: number) => { status: number; body: string };

async function startServer(respond: Responder) {
  let hits = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    if (request.headers["x-cron-secret"] !== SECRET) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (request.url !== "/api/deploy/runtime-status") {
      response.writeHead(404);
      response.end("wrong path");
      return;
    }
    const { status, body } = respond(hits);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function runHarness(env: Record<string, string>) {
  const harnessPath = writeHarness();
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      "bash",
      bashGateArgs(bashFixturePath(harnessPath), [], {
        STUB_NODE_DIR: path.dirname(process.execPath),
        STUB_CRON_SECRET: SECRET,
        STUB_TIMEOUT: "6",
        ...env,
      }),
      { encoding: "utf8", timeout: RUN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
      },
    );
  });
}

const READY_BODY = JSON.stringify({
  role: "cron-leader",
  cronEnabled: true,
  environmentRole: "production",
});
const STARTING_BODY = JSON.stringify({ status: "starting", detail: "route warming" });

describe("deploy step 14/15: the runtime-status read retries, then explains itself (#3965)", () => {
  it(
    "succeeds when the endpoint answers 503 a few times and then 200",
    async () => {
      const server = await startServer((hit) =>
        hit <= 3 ? { status: 503, body: STARTING_BODY } : { status: 200, body: READY_BODY },
      );
      try {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.stderr).not.toContain("ERR-TRAP-FIRED");
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(`PAYLOAD=${READY_BODY}\n`);
        expect(server.hits()).toBe(4);
      } finally {
        await server.close();
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "fails after its bound when the endpoint never stops answering 503, naming the status and the body",
    async () => {
      const server = await startServer(() => ({ status: 503, body: STARTING_BODY }));
      try {
        const result = await runHarness({ STUB_PORT: String(server.port) });
        expect(result.code).not.toBe(0);
        expect(result.stdout).not.toContain("PAYLOAD=");
        // Timeout 6s at a 2s interval: attempts at 0, 2, 4 and 6 seconds.
        expect(server.hits()).toBe(4);
        expect(result.stderr).toContain(
          "Internal app: /api/deploy/runtime-status did not answer HTTP 200 within 6s (4 attempts).",
        );
        expect(result.stderr).toContain("Last HTTP status: 503");
        expect(result.stderr).toContain(`Last response body: ${STARTING_BODY}`);
      } finally {
        await server.close();
      }
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "says there was no HTTP response at all when nothing is listening",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      const closedPort = server.port;
      await server.close();

      const result = await runHarness({ STUB_PORT: String(closedPort) });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("Last HTTP status: none (no HTTP response)");
      expect(result.stderr).toContain("ECONNREFUSED");
    },
    RUN_TIMEOUT_MS,
  );

  it(
    "stops at once, without retrying, when the container has no CRON_SECRET",
    async () => {
      const server = await startServer(() => ({ status: 200, body: READY_BODY }));
      try {
        const result = await runHarness({
          STUB_PORT: String(server.port),
          STUB_CRON_SECRET: "",
        });
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("CRON_SECRET is empty inside this container");
        expect(result.stderr).not.toContain("did not answer HTTP 200");
        expect(server.hits()).toBe(0);
      } finally {
        await server.close();
      }
    },
    RUN_TIMEOUT_MS,
  );

  it("checks the retry bound at step 3, before anything is pulled or migrated", () => {
    const step3 = SCRIPT.indexOf('step "3/20"');
    const step4 = SCRIPT.indexOf('step "4/20"');
    const check = SCRIPT.indexOf(
      'require_integer_setting_in_range RUNTIME_STATUS_TIMEOUT_SECONDS "$RUNTIME_STATUS_TIMEOUT_SECONDS"',
    );
    expect(step3).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(step3);
    expect(check).toBeLessThan(step4);
  });
});
