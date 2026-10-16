import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_RETENTION_CLASSES } from "@/lib/audit-retention-classes";
import { stripComments } from "./support/strip-comments";

/**
 * #3940: `AuditLog.retentionClass` is free text, so a value outside
 * `AUDIT_RETENTION_CLASSES` is storable. The nightly prune now reads such a
 * row as unclassified (owner decision, 17 Oct 2026), so it no longer lives
 * forever; this census keeps every writer on the known four in the first
 * place, so the fallback stays a safety net rather than a schedule.
 *
 * - `src/`: a `retentionClass` property set to a string literal must name a
 *   known class. Typed writers already get this from `AuditRetentionClass`;
 *   the scan also catches a cast or an untyped raw write.
 * - `prisma/migrations/`: a migration that inserts into "AuditLog" with a
 *   "retentionClass" column writes its class as the literal just before the
 *   `expiresAt` expression (the shape every such migration uses). That literal
 *   must be known, and an insert this scan cannot read fails rather than passes.
 *
 * Disk-scanning: run by name.
 */
const ROOT = process.cwd();
const KNOWN = new Set<string>(AUDIT_RETENTION_CLASSES);
const PREFIX = "#3940 audit retention class census (see docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md)";

function walk(dir: string, accept: (file: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : walk(full, accept);
    return accept(full) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(ROOT, file);

function retentionClassLiteralsIn(source: string): string[] {
  return [...stripComments(source).matchAll(/\bretentionClass\s*:\s*(?:[^"'`,}\n]*\?\s*)?["'`]([^"'`]*)["'`]/g)].map(
    (match) => match[1]
  );
}

function migrationAuditInsertClasses(sql: string): Array<string | null> {
  const statements = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/);
  return statements
    .filter((statement) => /INSERT\s+INTO\s+"AuditLog"\s*\([^)]*"retentionClass"/i.test(statement))
    .map((statement) => {
      const match = statement.match(/'([^']*)'\s*,\s*\n\s*timezone\('UTC',\s*statement_timestamp\(\)\)\s*\+\s*interval/);
      return match ? match[1] : null;
    });
}

describe("audit retention class writers stay on the known set (#3940)", () => {
  it("every retentionClass literal in src names a known class", () => {
    const offenders = walk(path.join(ROOT, "src"), (file) => /\.(ts|tsx)$/.test(file) && !file.includes("__tests__"))
      .flatMap((file) =>
        retentionClassLiteralsIn(readFileSync(file, "utf8"))
          .filter((value) => !KNOWN.has(value))
          .map((value) => `${relative(file)}: "${value}"`)
      );
    expect(offenders, `${PREFIX}: unknown retentionClass literal`).toEqual([]);
  });

  it("every migration that inserts an audit row writes a known class", () => {
    const migrations = walk(path.join(ROOT, "prisma", "migrations"), (file) => file.endsWith(".sql"));
    const inserts = migrations.flatMap((file) =>
      migrationAuditInsertClasses(readFileSync(file, "utf8")).map((value) => ({ file: relative(file), value }))
    );
    expect(inserts.length, `${PREFIX}: the scan found no audit-row inserts to check`).toBeGreaterThan(0);
    const offenders = inserts
      .filter(({ value }) => value === null || !KNOWN.has(value))
      .map(({ file, value }) => `${file}: ${value === null ? "class not readable by this scan" : `"${value}"`}`);
    expect(offenders, `${PREFIX}: an audit-row insert's class is unknown or unreadable`).toEqual([]);
  });

  it("the scanners catch what they claim to", () => {
    expect(retentionClassLiteralsIn('logAudit({ retentionClass: "standrad" })')).toEqual(["standrad"]);
    expect(retentionClassLiteralsIn('x = { retentionClass: overbooked ? "critical" : undefined }')).toEqual(["critical"]);
    expect(retentionClassLiteralsIn("// retentionClass: \"commented\"\nconst a = 1;")).toEqual([]);
    const sql = `INSERT INTO "AuditLog" ("id", "retentionClass", "expiresAt")\nSELECT\n  'x',\n  'standrad',\n  timezone('UTC', statement_timestamp()) + interval '7 years';\n`;
    expect(migrationAuditInsertClasses(sql)).toEqual(["standrad"]);
    expect(migrationAuditInsertClasses(`INSERT INTO "AuditLog" ("id", "retentionClass") VALUES ('x', 'critical');`)).toEqual([null]);
  });
});
