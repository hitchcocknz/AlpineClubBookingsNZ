/**
 * #4367: real-PostgreSQL test FILES take turns on the shared race database.
 *
 * Every `*.realdb.test.ts` file points at the one database named by
 * `CONCURRENCY_RACE_DATABASE_URL`, and many are not safe beside each other:
 * trigger DDL takes table-level locks, the global Xero outbox processor and the
 * #4234 ownership guard see other files' rows, and some cases scan whole
 * tables. CI runs them one file per step, and the race harness imports its
 * suites into one serial file, so both always passed. Separate files run in
 * parallel on one database failed intermittently instead (6 tests in 2 of 27
 * files on the first local run for #4367).
 *
 * Rather than police each suite, vitest.setup.ts registers this for every file
 * when the race env is on: a realdb file holds one session advisory lock for
 * its whole life, so a second file waits for the first to finish. The lock is
 * released when the connection ends, so a killed run leaves nothing stale.
 *
 * Two choices keep it invisible to the suites' own `pg_locks` barriers:
 * - the key is the two-int form `(4367, 1)` (`objsubid = 2`), which no suite
 *   or application lock uses — never the global `pg_advisory_xact_lock(1)`;
 * - a waiting file polls `pg_try_advisory_lock` instead of blocking, so it
 *   never shows as an ungranted advisory row. Barriers such as
 *   `ib-capacity-cancel-credit-restore` count any ungranted advisory row.
 */
import { Client } from "pg";
import { afterAll, beforeAll, expect } from "vitest";

import { assertSafeRaceDbUrl } from "./race-db-url";

export const REALDB_FILE_LOCK_KEY = [4367, 1] as const;

const REALDB_FILE_PATTERN = /\.realdb\.test\.tsx?$/;
const POLL_MS = 250;
// A queued file may wait for every file ahead of it; the run, not this hook,
// bounds the wait.
const WAIT_TIMEOUT_MS = 60 * 60 * 1000;

export function isRealdbTestFile(testPath: string | undefined): boolean {
  return testPath !== undefined && REALDB_FILE_PATTERN.test(testPath);
}

/** The slice of `pg.Client` the lock uses; a fake stands in for it in tests. */
export interface RealdbLockClient {
  connect(): Promise<unknown>;
  query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: R[] }>;
  end(): Promise<unknown>;
}

/**
 * Waits for this file's turn and returns its release, or null when the file
 * is not a realdb file or no race database is configured.
 */
export async function acquireRealdbFileLock(
  testPath: string | undefined,
  url: string,
  connect: (url: string) => RealdbLockClient = (connectionString) =>
    new Client({ connectionString }),
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, POLL_MS)),
): Promise<(() => Promise<void>) | null> {
  if (!isRealdbTestFile(testPath)) return null;
  // No URL: the suite self-skips or refuses on its own terms.
  if (url === "") return null;
  assertSafeRaceDbUrl(url, "Realdb file serialisation");
  const client = connect(url);
  await client.connect();
  try {
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [...REALDB_FILE_LOCK_KEY],
      );
      if (rows[0]?.locked) break;
      await pause();
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [...REALDB_FILE_LOCK_KEY]);
    } finally {
      await client.end();
    }
  };
}

export function serialiseRealdbFile(): void {
  let release: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    release = await acquireRealdbFileLock(
      expect.getState().testPath,
      process.env.CONCURRENCY_RACE_DATABASE_URL ?? "",
    );
  }, WAIT_TIMEOUT_MS);

  // hooks: "stack" runs this after the file's own teardown.
  afterAll(async () => {
    const held = release;
    release = null;
    await held?.();
  });
}
