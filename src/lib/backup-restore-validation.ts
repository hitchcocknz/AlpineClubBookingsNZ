/**
 * Two pure helpers for the nightly backup's restore-validation step (#4453
 * review, S-F2 / O-F11). Kept free of `server-only`, child processes and the
 * environment so the unit and real-PostgreSQL suites can run them as shipped.
 */

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
 * `pg_dump` writes each of these statements on one line at column 0. Lines
 * inside a `COPY … FROM stdin` block are row data and lines inside a
 * dollar-quoted body are routine source, so neither is ever touched.
 */
export function stripOwnershipAndPrivilegeStatements(sql: string): string {
  const out: string[] = [];
  let inCopy = false;
  let openDollarTag: string | null = null;
  for (const line of sql.split("\n")) {
    if (inCopy) {
      out.push(line);
      if (line === COPY_END) inCopy = false;
      continue;
    }
    if (openDollarTag === null) {
      if (COPY_FROM_STDIN.test(line)) {
        inCopy = true;
        out.push(line);
        continue;
      }
      if (OWNERSHIP_OR_PRIVILEGE_STATEMENT.test(line)) continue;
    }
    for (const tag of line.match(DOLLAR_QUOTE) ?? []) {
      if (openDollarTag === null) openDollarTag = tag;
      else if (tag === openDollarTag) openDollarTag = null;
    }
    out.push(line);
  }
  return out.join("\n");
}
