/**
 * #4453: the least-privilege role statements and the operator CLI that runs
 * them, without a database. What PostgreSQL does with the statements is proven
 * in `database-roles.realdb.test.ts`; this file pins their shape, their order,
 * and the CLI's refusals and dry-run default.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_ANONYMISED_REQUEST_COLUMNS } from "@/lib/audit-retention-classes";
import {
  APPEND_ONLY_RELATIONS,
  buildDatabaseRolesSql,
  DEFAULT_DATABASE_ROLE_NAMES,
  MIGRATION_HISTORY_RELATION,
} from "@/lib/database-roles";

const INPUT = {
  databaseName: "tacbookings",
  migrator: { roleName: "tac_migrator", password: "migrator-secret-0123456789" },
  app: { roleName: "tac_app", password: "app-secret-it's-quoted-0123" },
  auditRetention: { roleName: "tac_audit_retention", password: "retention-secret-0123456789" },
};

const indexOf = (statements: string[], fragment: string) => {
  const index = statements.findIndex((statement) => statement.includes(fragment));
  expect(index, `no statement contains ${fragment}`).toBeGreaterThanOrEqual(0);
  return index;
};

describe("buildDatabaseRolesSql (#4453)", () => {
  const statements = buildDatabaseRolesSql(INPUT);
  const sql = statements.join("\n");

  it("refuses one role in two slots, whatever its case", () => {
    expect(() =>
      buildDatabaseRolesSql({ ...INPUT, app: { ...INPUT.app, roleName: "TAC_MIGRATOR" } }),
    ).toThrow(/three different roles/);
  });

  it("refuses a name the dollar-quoted blocks cannot carry", () => {
    expect(() =>
      buildDatabaseRolesSql({ ...INPUT, app: { ...INPUT.app, roleName: "tac-app" } }),
    ).toThrow(/Refusing to build provisioning SQL/);
    expect(() => buildDatabaseRolesSql({ ...INPUT, databaseName: "db$$" })).toThrow();
  });

  it("pins every role NOSUPERUSER and strips its memberships before granting anything", () => {
    for (const { roleName } of [INPUT.migrator, INPUT.app, INPUT.auditRetention]) {
      const alter = indexOf(statements, `ALTER ROLE "${roleName}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      const strip = statements.findIndex(
        (statement) => statement.includes("REVOKE %I FROM %I GRANTED BY %I") && statement.includes(`'${roleName}'`),
      );
      expect(strip).toBeGreaterThan(alter);
      expect(strip).toBeLessThan(indexOf(statements, "GRANT CONNECT ON DATABASE"));
    }
    expect(sql).not.toMatch(/(?<!NO)SUPERUSER|(?<!NO)CREATEROLE|(?<!NO)BYPASSRLS/);
  });

  it("quotes each password as a literal, only in its own ALTER ROLE", () => {
    expect(sql).toContain(`PASSWORD 'app-secret-it''s-quoted-0123'`);
    for (const { password } of [INPUT.migrator, INPUT.auditRetention]) {
      expect(statements.filter((statement) => statement.includes(password))).toHaveLength(1);
    }
  });

  it("never grants to or revokes from PUBLIC", () => {
    expect(sql).not.toMatch(/\b(TO|FROM)\s+PUBLIC\b/i);
  });

  it("hands ownership to the migration role before declaring its default privileges", () => {
    const transfer = indexOf(statements, "OWNER TO %I");
    expect(transfer).toBeLessThan(indexOf(statements, `ALTER DEFAULT PRIVILEGES FOR ROLE "tac_migrator"`));
    expect(statements[transfer]).toContain("d.deptype IN ('e', 'a', 'i')");
  });

  it("strips the app and retention roles before granting back, and narrows every append-only relation", () => {
    const strip = indexOf(statements, `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "tac_app"`);
    const grant = indexOf(statements, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "tac_app"`);
    const narrow = indexOf(statements, "REVOKE UPDATE, DELETE, TRUNCATE");
    expect(strip).toBeLessThan(grant);
    expect(grant).toBeLessThan(narrow);
    for (const relation of APPEND_ONLY_RELATIONS) {
      expect(statements[narrow]).toContain(`REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "public"."${relation}" FROM "tac_app"`);
    }
    expect(statements[narrow]).toContain(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "public"."${MIGRATION_HISTORY_RELATION}" FROM "tac_app"`);
  });

  it("gives the retention role SELECT, DELETE and UPDATE of exactly the anonymised columns", () => {
    const columns = AUDIT_ANONYMISED_REQUEST_COLUMNS.map((column) => `"${column}"`).join(", ");
    expect(sql).toContain(`GRANT SELECT, DELETE ON TABLE "public"."AuditLog" TO "tac_audit_retention"`);
    expect(sql).toContain(`GRANT UPDATE (${columns}) ON TABLE "public"."AuditLog" TO "tac_audit_retention"`);
    expect(sql).not.toMatch(/GRANT [^;]*INSERT[^;]*TO "tac_audit_retention"/);
  });

  it("grants the application's table rights to tables future migrations create", () => {
    expect(sql).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "tac_migrator" IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "tac_app";`,
    );
    expect(sql).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "tac_migrator" IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO "tac_app";`,
    );
  });

  it("re-checks the result last, and refuses to commit a breach", () => {
    const last = statements.at(-1) ?? "";
    expect(last).toContain("Refusing to commit");
    for (const relation of APPEND_ONLY_RELATIONS) {
      expect(last).toContain(`can still change rows of %.', '${relation}'`);
    }
  });
});

describe("pnpm run db:provision-roles (#4453)", () => {
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(path.join(process.cwd(), "node_modules/.bin/tsx"), ["scripts/provision-database-roles.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // Unroutable: a dry run must never connect, and a refusal must come first.
        DB_ROLES_PROVISION_DATABASE_URL: "postgresql://tac:unused@192.0.2.1:5432/tacbookings",
        ...env,
      },
    });
  const passwords = {
    MIGRATION_DB_PASSWORD: "m".repeat(24),
    APP_DB_PASSWORD: "a".repeat(24),
    AUDIT_RETENTION_DB_PASSWORD: "r".repeat(24),
  };

  it("is a dry run by default: prints the statements with placeholders and connects to nothing", () => {
    const result = cli([], passwords);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("DRY RUN for database tacbookings: nothing was executed.");
    expect(result.stdout).toContain("PASSWORD 'REDACTED-DRY-RUN-PLACEHOLDER'");
    for (const secret of Object.values(passwords)) expect(result.stdout).not.toContain(secret);
    for (const role of Object.values(DEFAULT_DATABASE_ROLE_NAMES)) expect(result.stdout).toContain(`"${role}"`);
  });

  it("refuses to provision the role it connects as", () => {
    const result = cli([], { APP_DB_USER: "tac" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is the role this script connects as");
  });

  it("refuses the AI Diagnostics role", () => {
    const result = cli([], { AUDIT_RETENTION_DB_USER: "ai_diagnostics_ro" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ADR-007");
  });

  it("with --apply, refuses a missing, short or URL-unsafe password before connecting", () => {
    const missing = cli(["--apply"], { ...passwords, APP_DB_PASSWORD: "" });
    expect(missing.stderr).toContain("Set APP_DB_PASSWORD");
    const short = cli(["--apply"], { ...passwords, MIGRATION_DB_PASSWORD: "short" });
    expect(short.stderr).toContain("at least 20 characters");
    const unsafe = cli(["--apply"], { ...passwords, AUDIT_RETENTION_DB_PASSWORD: "has/a/slash-and-is-long-enough" });
    expect(unsafe.stderr).toContain("cannot carry unencoded");
    for (const result of [missing, short, unsafe]) {
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("a".repeat(24));
    }
  });
});
