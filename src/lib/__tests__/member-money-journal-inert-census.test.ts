/**
 * M1 (#4513) ships the member-money journal inert: no production path reads it
 * or posts to it. This census reads every non-test source file under `src/` and
 * `scripts/`, and the seeds and other top-level files in `prisma/`, and fails on
 * a journal reference outside the module boundary and the files that only name,
 * provision or verify it. The migration is SQL, outside the scan. A later child that adds a writer or reader edits this
 * list in the same PR, so the switch is a reviewed decision, not a side effect.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["node_modules", "__tests__", "generated", ".next"]);

/** Files allowed to name the journal, and why. Nothing here writes a row. */
const ALLOWED: Record<string, string> = {
  "src/lib/member-money-tables.ts": "the relation list provisioning and the verifier share",
  "src/lib/database-roles.ts": "least-privilege provisioning (INSERT/SELECT grants, no rows)",
  "src/lib/member-merge-snapshot-columns.ts": "member-merge classification strings",
  "scripts/verify-member-money-journal.ts": "operator verifier in a READ ONLY transaction",
};
const BOUNDARY = "src/lib/member-money/";

/**
 * A journal table, enum or Prisma delegate; a relation field reaching it from
 * another model (`include: { memberMoneyLines: true }`); one of its SQL
 * functions; or an import of the boundary.
 */
const REFERENCE = [
  /\bMemberMoney[A-Z]\w*/,
  /\bmemberMoney[A-Z]\w*/,
  /\bmember_money_\w+/,
  /["'`](?:@\/lib\/|(?:\.\.?\/)+(?:src\/lib\/|lib\/)?)member-money(?:-tables)?(?:\/[\w/]*)?["'`]/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(path);
    return SOURCE.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name) ? [path] : [];
  });
}

/** The top-level files of `prisma/` (seeds, config); not its migration fixtures. */
function prismaFiles(): string[] {
  return readdirSync(join(ROOT, "prisma"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(ROOT, "prisma", entry.name));
}

function referencing(): string[] {
  return [...["src", "scripts"].flatMap((dir) => sourceFiles(join(ROOT, dir))), ...prismaFiles()]
    .filter((file) => REFERENCE.some((pattern) => pattern.test(readFileSync(file, "utf8"))))
    .map((file) => relative(ROOT, file).split(sep).join("/"));
}

describe("member money journal stays inert in M1 (#4513)", () => {
  const found = referencing();

  it("has no reader or writer outside the boundary and its named support files", () => {
    const offenders = found.filter((file) => !file.startsWith(BOUNDARY) && !(file in ALLOWED));
    expect(offenders, "a production path names the member-money journal; M1 ships it inert").toEqual([]);
  });

  it("is not vacuous: every allowed file and the boundary still match", () => {
    for (const file of Object.keys(ALLOWED)) expect(found).toContain(file);
    expect(found.some((file) => file.startsWith(BOUNDARY))).toBe(true);
  });

  it("posts nothing from inside the boundary or the verifier", () => {
    for (const file of [...found.filter((f) => f.startsWith(BOUNDARY)), "scripts/verify-member-money-journal.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+(public\.)?"MemberMoney|DELETE\s+FROM|TRUNCATE)\b/i);
      expect(text, file).not.toMatch(/\.memberMoney\w*\s*\.\s*(create|update|upsert|delete)/);
    }
    expect(readFileSync(join(ROOT, "scripts/verify-member-money-journal.ts"), "utf8")).toMatch(/READ ONLY/);
  });
});
