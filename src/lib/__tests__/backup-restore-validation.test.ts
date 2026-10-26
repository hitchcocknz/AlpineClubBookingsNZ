/**
 * #4453 review (S-F2): the restore-validation guard compares WHERE a connection
 * string points, not who connects; and the validation restore drops only the
 * ownership and privilege statements, never row data or routine source.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import {
  createOwnershipAndPrivilegeStripStream,
  isSameDatabaseTarget,
  restoreDumpWithoutOwnershipOrPrivileges,
  stripOwnershipAndPrivilegeStatements,
} from "@/lib/backup-restore-validation";

const LIVE = "postgresql://tac_app:app-pw@postgres:5432/tacbookings?connection_limit=10&pool_timeout=10";

describe("isSameDatabaseTarget", () => {
  it.each([
    ["another role and password", "postgresql://tac:op-pw@postgres:5432/tacbookings"],
    ["no port (the default)", "postgresql://tac_restore_check:pw@postgres/tacbookings"],
    ["other parameters", "postgresql://u:p@postgres:5432/tacbookings?sslmode=disable&options=-c%20x%3D1"],
    ["a host spelled in capitals", "postgresql://u:p@POSTGRES:5432/tacbookings"],
    ["a libpq dbname override", "postgresql://u:p@postgres:5432/scratch?dbname=tacbookings"],
  ])("treats %s as the live database", (_label, url) => {
    expect(isSameDatabaseTarget(url, LIVE)).toBe(true);
  });

  it("treats any loopback spelling as one host", () => {
    expect(
      isSameDatabaseTarget("postgresql://a@localhost/tacbookings", "postgresql://b@127.0.0.1:5432/tacbookings"),
    ).toBe(true);
  });

  it.each([
    ["another database name", "postgresql://tac_app:app-pw@postgres:5432/tacbookings_restore_check"],
    ["another host", "postgresql://tac_app:app-pw@shadow:5432/tacbookings"],
    ["another port", "postgresql://tac_app:app-pw@postgres:5433/tacbookings"],
  ])("allows %s", (_label, url) => {
    expect(isSameDatabaseTarget(url, LIVE)).toBe(false);
  });

  it("fails closed on a string it cannot parse", () => {
    expect(isSameDatabaseTarget("host=postgres dbname=other", LIVE)).toBe(true);
  });
});

describe("stripOwnershipAndPrivilegeStatements", () => {
  const dump = [
    "CREATE TABLE public.\"BookingLedgerLine\" (",
    "    id text NOT NULL",
    ");",
    "ALTER TABLE public.\"BookingLedgerLine\" OWNER TO tac_migrator;",
    "ALTER SCHEMA public OWNER TO pg_database_owner;",
    "ALTER SEQUENCE public.\"PaymentTransaction_insertionSeq_seq\" OWNED BY public.\"PaymentTransaction\".\"insertionSeq\";",
    "CREATE FUNCTION public.f() RETURNS trigger",
    "    LANGUAGE plpgsql",
    "    AS $$",
    "GRANT ALL ON TABLE x TO y;",
    "BEGIN RETURN NEW; END;",
    "$$;",
    "ALTER FUNCTION public.f() OWNER TO tac_migrator;",
    "COPY public.\"AuditLog\" (id, action) FROM stdin;",
    "GRANT ALL ON TABLE public.\"x\" TO tac_app;\tlooks like a grant, is a row",
    "\\.",
    "GRANT SELECT,INSERT ON TABLE public.\"BookingLedgerLine\" TO tac_app;",
    "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE tac_migrator IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO tac_app;",
    "",
  ].join("\n");
  const stripped = stripOwnershipAndPrivilegeStatements(dump);

  it("removes every owner, grant, revoke and default-privilege statement", () => {
    expect(stripped).not.toContain("OWNER TO");
    expect(stripped).not.toMatch(/^GRANT SELECT/m);
    expect(stripped).not.toMatch(/^REVOKE/m);
    expect(stripped).not.toContain("ALTER DEFAULT PRIVILEGES");
  });

  it("keeps row data, routine bodies, OWNED BY and the schema itself", () => {
    expect(stripped).toContain("GRANT ALL ON TABLE public.\"x\" TO tac_app;\tlooks like a grant, is a row");
    expect(stripped).toContain("GRANT ALL ON TABLE x TO y;");
    expect(stripped).toContain("OWNED BY public.\"PaymentTransaction\"");
    expect(stripped).toContain("CREATE TABLE public.\"BookingLedgerLine\" (");
    expect(stripped.split("\n")).toHaveLength(dump.split("\n").length - 6);
  });
});

describe("the streamed strip (#4453 review N2)", () => {
  // A dump with a multi-byte character (a macron) and no trailing newline, so a
  // chunk boundary can split a character, a line, or the last line.
  const dump = [
    "CREATE TABLE public.\"Member\" (\"lastName\" text);",
    "ALTER TABLE public.\"Member\" OWNER TO tac_migrator;",
    "COPY public.\"Member\" (\"lastName\") FROM stdin;",
    "Māori-Tūhoe",
    "GRANT ALL ON TABLE x TO y;",
    "\\.",
    "CREATE FUNCTION public.f() RETURNS int AS $_$",
    "REVOKE ALL ON TABLE x FROM y;",
    "$_$;",
    "GRANT SELECT ON TABLE public.\"Member\" TO tac_app;",
    "SELECT 'last line, no newline';",
  ].join("\n");
  const bytes = Buffer.from(dump, "utf8");

  async function streamed(chunkSize: number): Promise<string> {
    const chunks: Buffer[] = [];
    for (let start = 0; start < bytes.length; start += chunkSize) chunks.push(bytes.subarray(start, start + chunkSize));
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(chunks),
      createOwnershipAndPrivilegeStripStream(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          out.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
    return Buffer.concat(out).toString("utf8");
  }

  it.each([1, 2, 3, 7, 64, 65_536])("matches the pure function byte for byte, in %i-byte chunks", async (size) => {
    expect(await streamed(size)).toBe(stripOwnershipAndPrivilegeStatements(dump));
  });

  it("matches with a trailing newline too", async () => {
    const withNewline = `${dump}\n`;
    const out: string[] = [];
    await pipeline(
      Readable.from([Buffer.from(withNewline)]),
      createOwnershipAndPrivilegeStripStream(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          out.push(chunk.toString("utf8"));
          callback();
        },
      }),
    );
    expect(out.join("")).toBe(stripOwnershipAndPrivilegeStatements(withNewline));
  });

  describe("restoreDumpWithoutOwnershipOrPrivileges", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restore-validation-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const gz = path.join(dir, "backup.sql.gz");
    writeFileSync(gz, gzipSync(bytes));
    // A stand-in `psql` on PATH: records its stdin and arguments, exits as told.
    const bin = path.join(dir, "bin");
    const psql = path.join(bin, "psql");
    const makePsql = (body: string) => {
      rmSync(bin, { recursive: true, force: true });
      mkdirSync(bin);
      writeFileSync(psql, `#!/bin/sh\n${body}\n`);
      chmodSync(psql, 0o755);
    };
    const env = () => ({ PATH: `${bin}:${process.env.PATH ?? ""}`, CAPTURE: path.join(dir, "stdin.sql") });

    it("streams the gunzipped, stripped dump into psql's stdin", async () => {
      makePsql('printf "%s\\n" "$@" > "$CAPTURE.args"; cat > "$CAPTURE"');
      await restoreDumpWithoutOwnershipOrPrivileges({
        sourcePath: gz,
        argvUrl: "postgresql://check@shadow/tacbookings_restore_check",
        env: env(),
        timeoutMs: 30_000,
      });
      expect(readFileSync(path.join(dir, "stdin.sql"), "utf8")).toBe(stripOwnershipAndPrivilegeStatements(dump));
      expect(readFileSync(path.join(dir, "stdin.sql.args"), "utf8")).toContain("ON_ERROR_STOP=1");
    });

    it("reports psql's own reason when it stops early", async () => {
      makePsql('head -c 10 >/dev/null; echo "ERROR:  must be owner of table Member" >&2; exit 3');
      await expect(
        restoreDumpWithoutOwnershipOrPrivileges({
          sourcePath: gz,
          argvUrl: "postgresql://check@shadow/tacbookings_restore_check",
          env: env(),
          timeoutMs: 30_000,
        }),
      ).rejects.toThrow(/psql exited 3: ERROR: {2}must be owner of table Member/);
    });
  });
});
