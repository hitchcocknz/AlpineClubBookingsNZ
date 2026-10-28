/**
 * The verifier's expected enforcement (`MEMBER_MONEY_DATABASE_SHAPE`) is the
 * migration's, derived here from the file itself (#4513). A changed function
 * body or constraint fails this until the constant moves with it; the realdb
 * suite then proves the verifier reads the same values back from PostgreSQL.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEMBER_MONEY_DATABASE_SHAPE } from "@/lib/member-money/internal/database-shape";
import { MEMBER_MONEY_RELATIONS, MEMBER_MONEY_SEALED_RELATIONS } from "@/lib/member-money-tables";

const MIGRATION = readFileSync("prisma/migrations/20261127010000_member_money_journal/migration.sql", "utf8");

describe("member money database shape (#4513)", () => {
  it("holds the md5 of every member_money_* function body exactly as the migration writes it", () => {
    const functions = Object.fromEntries(
      [...MIGRATION.matchAll(/CREATE FUNCTION (member_money_\w+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)]
        .map(([, name, body]) => [name, createHash("md5").update(body!).digest("hex")]),
    );
    expect(MEMBER_MONEY_DATABASE_SHAPE.functions).toEqual(functions);
  });

  it("names every constraint the migration adds, on the relation it adds it to", () => {
    const constraints: Record<string, string[]> = {};
    for (const [, table, body] of MIGRATION.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
      const named = [...body!.matchAll(/CONSTRAINT "(\w+)"/g)].map(([, name]) => name!);
      constraints[table!] = /PRIMARY KEY/.test(body!) && named.length === 0 ? [`${table}_pkey`] : named;
    }
    for (const [, table, name] of MIGRATION.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/g)) {
      constraints[table!]!.push(name!);
    }
    const sorted = (record: Record<string, readonly string[]>) =>
      Object.fromEntries(Object.entries(record).map(([key, names]) => [key, [...names].sort()]));
    expect(sorted(MEMBER_MONEY_DATABASE_SHAPE.constraints)).toEqual(sorted(constraints));
    expect(Object.keys(constraints).sort()).toEqual([...MEMBER_MONEY_RELATIONS].sort());
  });

  it("seals exactly the relations the migration gives a seal trigger", () => {
    const sealed = [...MIGRATION.matchAll(/CREATE TRIGGER member_money_seal BEFORE INSERT ON "(\w+)"/g)].map(([, table]) => table);
    expect(sealed.sort()).toEqual([...MEMBER_MONEY_SEALED_RELATIONS].sort());
  });
});
