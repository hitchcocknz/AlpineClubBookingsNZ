/**
 * The nightly backup's restore-validation helpers (#4453 review, S-F2 / O-F11,
 * N2, N5): the live-database guard, and the owner/grant filter in a pure and a
 * streaming form. Kept free of `server-only` and of the environment so the unit
 * and real-PostgreSQL suites run them as shipped.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DEFAULT_POSTGRES_PORT = "5432";

interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
}

/**
 * Where a connection string points, ignoring who connects and how. libpq's
 * `host`, `port` and `dbname` query parameters override the URL's own parts, so
 * they are read too; a loopback host is one host whatever its spelling.
 */
function databaseTarget(connectionString: string): DatabaseTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    return null;
  }
  const host = (parsed.searchParams.get("host") ?? parsed.hostname).toLowerCase();
  const port = parsed.searchParams.get("port") ?? (parsed.port || DEFAULT_POSTGRES_PORT);
  const database =
    parsed.searchParams.get("dbname") ?? decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    host: LOOPBACK_HOSTS.has(host) ? "loopback" : host,
    port,
    database,
  };
}

/**
 * True when two connection strings reach the same database: same host, port and
 * database name, whatever the user, password or other parameters.
 *
 * The restore-validation step starts with `DROP SCHEMA public CASCADE`, so it must
 * never be handed the live database. The previous guard compared whole URLs,
 * which stopped matching the moment the app's `DATABASE_URL` named a different
 * ROLE from the validation URL — exactly what the least-privilege roles do. An
 * unparseable string counts as the same database: refusing is the safe answer.
 * Two names for one host (a container name and its IP) cannot be told apart
 * here; the validation database must also have a different NAME, which the
 * deployment guide requires.
 */
export function isSameDatabaseTarget(first: string, second: string): boolean {
  const a = databaseTarget(first);
  const b = databaseTarget(second);
  if (!a || !b) return true;
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

/** A top-level statement that sets an owner or a privilege, as `pg_dump` writes it. */
const OWNERSHIP_OR_PRIVILEGE_STATEMENT =
  /^(ALTER [A-Z ]+ .* OWNER TO .*;|GRANT .*;|REVOKE .*;|ALTER DEFAULT PRIVILEGES .*;)$/;
const COPY_FROM_STDIN = /^COPY .* FROM stdin;$/;
const COPY_END = "\\.";
const DOLLAR_QUOTE = /\$[A-Za-z_0-9]*\$/g;

/**
 * The one line-by-line state machine both forms below run (`INV-SSOT`): it says
 * whether each line of a plain `pg_dump` is kept.
 *
 * `pg_dump` writes each owner and privilege statement on one line at column 0.
 * Lines inside a `COPY … FROM stdin` block are row data and lines inside a
 * dollar-quoted body are routine source, so neither is ever dropped. A `$tag$`
 * inside a single-quoted literal can desynchronise the dollar tracker; it then
 * KEEPS later owner lines, so the non-superuser restore fails closed rather than
 * dropping anything it should not.
 */
class OwnershipAndPrivilegeLineFilter {
  private inCopy = false;
  private openDollarTag: string | null = null;

  keep(line: string): boolean {
    if (this.inCopy) {
      if (line === COPY_END) this.inCopy = false;
      return true;
    }
    if (this.openDollarTag === null) {
      if (COPY_FROM_STDIN.test(line)) {
        this.inCopy = true;
        return true;
      }
      if (OWNERSHIP_OR_PRIVILEGE_STATEMENT.test(line)) return false;
    }
    for (const tag of line.match(DOLLAR_QUOTE) ?? []) {
      if (this.openDollarTag === null) this.openDollarTag = tag;
      else if (tag === this.openDollarTag) this.openDollarTag = null;
    }
    return true;
  }
}

/**
 * The backup SQL with every ownership and privilege statement removed, for the
 * restore-validation run only. This is what `pg_restore --no-owner --no-acl`
 * does for an archive; a plain-SQL dump has no such switch.
 *
 * Why: since #4453 a dump carries `OWNER TO <migration role>` and the role
 * grants, which only a superuser (or a member of those roles) may replay. The
 * validation proves the DATA restores, so it can run as a dedicated
 * non-superuser that owns only the shadow database, and the app never needs a
 * superuser credential. The real backup file is not changed: a disaster-recovery
 * restore, run by the operator, keeps the owners and grants.
 *
 * The whole-string form, for tests and small inputs; the validation itself runs
 * the streaming form below, so a large dump is never held in memory.
 */
export function stripOwnershipAndPrivilegeStatements(sql: string): string {
  const filter = new OwnershipAndPrivilegeLineFilter();
  return sql
    .split("\n")
    .filter((line) => filter.keep(line))
    .join("\n");
}

/**
 * The same filter as a stream (#4453 review N2): bytes in, bytes out, one line
 * held at a time. Output is byte-identical to `stripOwnershipAndPrivilegeStatements`
 * over the whole input, including a last line with no newline.
 */
export function createOwnershipAndPrivilegeStripStream(): Transform {
  const filter = new OwnershipAndPrivilegeLineFilter();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      const kept = lines.filter((line) => filter.keep(line));
      callback(null, kept.length > 0 ? `${kept.join("\n")}\n` : undefined);
    },
    flush(callback) {
      pending += decoder.end();
      callback(null, filter.keep(pending) ? pending : undefined);
    },
  });
}

/**
 * Restore a gzipped plain dump into the validation database with owners and
 * grants left out, streamed end to end: file → gunzip → filter → `psql` stdin.
 * Throws with psql's own message (its first 64 KiB) when the restore fails.
 */
export async function restoreDumpWithoutOwnershipOrPrivileges(input: {
  sourcePath: string;
  argvUrl: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  const psql = spawn("psql", [input.argvUrl, "-q", "-v", "ON_ERROR_STOP=1"], {
    env: input.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  psql.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 65_536) stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    psql.on("error", reject);
    psql.on("close", (code) => resolve(code));
  });
  const timer = setTimeout(() => psql.kill("SIGKILL"), input.timeoutMs);
  try {
    let streamError: unknown;
    try {
      await pipeline(
        createReadStream(input.sourcePath),
        createGunzip(),
        createOwnershipAndPrivilegeStripStream(),
        psql.stdin,
      );
    } catch (error) {
      // psql stopping early (ON_ERROR_STOP) closes its stdin: report psql's
      // reason, not the broken pipe it caused.
      streamError = error;
    }
    const code = await exited;
    if (code !== 0) {
      throw new Error(`Restore-validation psql exited ${code ?? "on a signal"}: ${stderr.trim()}`);
    }
    if (streamError) throw streamError;
  } finally {
    clearTimeout(timer);
  }
}
