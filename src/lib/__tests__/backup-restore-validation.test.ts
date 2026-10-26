/**
 * #4453 review (S-F2): the restore-validation guard compares WHERE a connection
 * string points, not who connects; and the validation restore drops only the
 * ownership and privilege statements, never row data or routine source.
 */
import { describe, expect, it } from "vitest";

import {
  isSameDatabaseTarget,
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
