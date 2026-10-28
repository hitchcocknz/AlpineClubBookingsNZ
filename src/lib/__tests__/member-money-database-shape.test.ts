/**
 * The verifier's expected enforcement (`MEMBER_MONEY_DATABASE_SHAPE`) is the
 * migration's, derived here from the file itself (#4513). A changed function
 * body fails this until the constant moves with it, as does a constraint,
 * trigger or unique index added, dropped or moved to another relation. The
 * catalog normalises those definitions' text, so the realdb suite checks their
 * digests against a freshly migrated database.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEMBER_MONEY_DATABASE_SHAPE } from "@/lib/member-money/internal/database-shape";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";

const MIGRATION = readFileSync("prisma/migrations/20261127010000_member_money_journal/migration.sql", "utf8");

/** Each relation's names, sorted, from `[relation, name]` pairs. */
function namesByRelation(pairs: Iterable<readonly [string, string]>) {
  const names: Record<string, string[]> = Object.fromEntries(MEMBER_MONEY_RELATIONS.map((relation) => [relation, []]));
  for (const [relation, name] of pairs) names[relation]!.push(name);
  return Object.fromEntries(Object.entries(names).map(([relation, list]) => [relation, list.sort()]));
}
const pinnedNames = (pins: Record<string, Record<string, string>>) =>
  Object.fromEntries(Object.entries(pins).map(([relation, digests]) => [relation, Object.keys(digests).sort()]));
/** Each table's primary key index, named as PostgreSQL names it; the constraint test proves each exists. */
const primaryKeys = MEMBER_MONEY_RELATIONS.map((relation) => [relation, `${relation}_pkey`] as const);

describe("member money database shape (#4513)", () => {
  it("holds the md5 of every member_money_* function body exactly as the migration writes it", () => {
    const functions = Object.fromEntries(
      [...MIGRATION.matchAll(/CREATE FUNCTION (member_money_\w+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/g)]
        .map(([, name, body]) => [name, createHash("md5").update(body!).digest("hex")]),
    );
    expect(MEMBER_MONEY_DATABASE_SHAPE.functions).toEqual(functions);
  });

  it("pins every constraint the migration adds, on the relation it adds it to", () => {
    const constraints: (readonly [string, string])[] = [];
    for (const [, table, body] of MIGRATION.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
      const named = [...body!.matchAll(/CONSTRAINT "(\w+)"/g)].map(([, name]) => name!);
      const names = /PRIMARY KEY/.test(body!) && named.length === 0 ? [`${table}_pkey`] : named;
      constraints.push(...names.map((name) => [table!, name] as const));
    }
    for (const [, table, name] of MIGRATION.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/g)) {
      constraints.push([table!, name!]);
    }
    expect(pinnedNames(MEMBER_MONEY_DATABASE_SHAPE.constraints)).toEqual(namesByRelation(constraints));
  });

  it("pins every trigger the migration creates, on the relation it creates it on", () => {
    const triggers = [...MIGRATION.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER (\w+) [\s\S]*? ON "(\w+)"/g)]
      .map(([, name, relation]) => [relation!, name!] as const);
    expect(pinnedNames(MEMBER_MONEY_DATABASE_SHAPE.triggers)).toEqual(namesByRelation(triggers));
  });

  it("pins every unique index the migration creates, primary keys included", () => {
    const indexes = [...MIGRATION.matchAll(/CREATE UNIQUE INDEX "(\w+)" ON "(\w+)"/g)]
      .map(([, name, relation]) => [relation!, name!] as const);
    expect(pinnedNames(MEMBER_MONEY_DATABASE_SHAPE.uniqueIndexes)).toEqual(namesByRelation([...indexes, ...primaryKeys]));
  });

  it("holds an md5 digest for every pinned definition", () => {
    const definitions = (["constraints", "triggers", "uniqueIndexes"] as const).flatMap((kind) =>
      Object.values<Record<string, string>>(MEMBER_MONEY_DATABASE_SHAPE[kind]).flatMap((pins) => Object.values(pins)));
    const digests = [...Object.values(MEMBER_MONEY_DATABASE_SHAPE.functions), ...definitions];
    expect(digests.filter((digest) => !/^[0-9a-f]{32}$/.test(digest))).toEqual([]);
  });
});
