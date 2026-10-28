import type { Client } from "pg";
import { z } from "zod";
import { APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES } from "../../database-roles";
import { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";
import { MEMBER_MONEY_DATABASE_SHAPE } from "./database-shape";

const Finding = z.object({ identity: z.string(), problem: z.string() });
export type MemberMoneyFinding = z.infer<typeof Finding>;

/**
 * `checked`: the role's effective table rights were compared with INSERT/SELECT.
 * `not_applicable`: the role is a superuser or owns every journal relation, as
 * on a single-role install, where no grant can narrow it (`INV-OPS-016`).
 */
export type MemberMoneyGrantCheck = "checked" | "not_applicable";

/** The catalog-defined parts of `MEMBER_MONEY_DATABASE_SHAPE`, and what each finding is called. */
const DEFINITION_PROBLEMS = {
  constraints: { unusable: "missing_or_unvalidated_constraint", changed: "changed_constraint" },
  triggers: { unusable: "missing_or_disabled_trigger", changed: "changed_trigger" },
  uniqueIndexes: { unusable: "missing_or_invalid_unique_index", changed: "changed_unique_index" },
} as const;

const Definition = z.object({
  kind: z.enum(["constraints", "triggers", "uniqueIndexes"]),
  relation: z.string(),
  name: z.string(),
  digest: z.string(),
  /** Validated, enabled for ordinary sessions (Origin or Always), or valid. */
  usable: z.boolean(),
});
export type MemberMoneyDefinition = z.infer<typeof Definition>;

/** The settings `pg_get_*def` text depends on, fixed while the definitions are read. */
const DEPARSE_SETTINGS = { searchPath: "pg_catalog, public", quoteAllIdentifiers: "off" };

/**
 * Every constraint, trigger and unique index on the journal relations, each
 * definition as an md5 of the catalog's text. The session's settings are put
 * back afterwards.
 */
export async function readMemberMoneyDefinitions(client: Client): Promise<MemberMoneyDefinition[]> {
  const Settings = z.object({ searchPath: z.string(), quoteAllIdentifiers: z.string() });
  const saved = Settings.parse((await client.query(`SELECT current_setting('search_path') AS "searchPath",
    current_setting('quote_all_identifiers') AS "quoteAllIdentifiers"`)).rows[0]);
  const apply = (settings: z.infer<typeof Settings>) => client.query(
    `SELECT set_config('search_path', $1, false), set_config('quote_all_identifiers', $2, false)`,
    [settings.searchPath, settings.quoteAllIdentifiers],
  );
  await apply(DEPARSE_SETTINGS);
  let rows: unknown[];
  try {
    ({ rows } = await client.query(`
      SELECT 'constraints' AS kind, c.relname AS relation, k.conname AS name,
        md5(pg_catalog.pg_get_constraintdef(k.oid)) AS digest, k.convalidated AS usable
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid AND k.contype <> 't'
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
      UNION ALL
      SELECT 'triggers', c.relname, t.tgname, md5(pg_catalog.pg_get_triggerdef(t.oid)), t.tgenabled IN ('O', 'A')
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
      UNION ALL
      SELECT 'uniqueIndexes', c.relname, ic.relname, md5(pg_catalog.pg_get_indexdef(i.indexrelid)), i.indisvalid
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indrelid = c.oid AND i.indisunique
        JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])
    `, [[...MEMBER_MONEY_RELATIONS]]));
  } catch (error) {
    // An aborted transaction restores the settings when it rolls back.
    await apply(saved).catch(() => undefined);
    throw error;
  }
  await apply(saved);
  return z.array(Definition).parse(rows);
}

/** Operator-only evidence query. Run inside a read-only repeatable-read snapshot. */
export async function verifyMemberMoneyJournal(
  client: Client,
  appRole: string,
): Promise<{ findings: MemberMoneyFinding[]; grantCheck: MemberMoneyGrantCheck }> {
  const batches = await client.query(`
    SELECT j.id AS identity, unnest(public.member_money_batch_errors(j.id)) AS problem
    FROM public."MemberMoneyJournal" j
    UNION ALL
    SELECT e.id, 'missing_journal' FROM public."MemberMoneyEvent" e
    LEFT JOIN public."MemberMoneyJournal" j ON j."eventId" = e.id WHERE j.id IS NULL
  `);
  const findings = z.array(Finding).parse(batches.rows);

  const functions = await client.query(`
    SELECT expected.name AS identity,
      CASE WHEN count(p.oid) = 0 THEN 'missing_function' ELSE 'changed_function' END AS problem
    FROM jsonb_each_text($1::jsonb) AS expected(name, digest)
    LEFT JOIN pg_catalog.pg_proc p ON p.proname = expected.name
      AND p.pronamespace = 'public'::regnamespace
    GROUP BY expected.name, expected.digest
    HAVING count(p.oid) <> 1 OR bool_or(md5(p.prosrc) <> expected.digest)
  `, [JSON.stringify(MEMBER_MONEY_DATABASE_SHAPE.functions)]);
  findings.push(...z.array(Finding).parse(functions.rows));

  const definitions = new Map((await readMemberMoneyDefinitions(client))
    .map((found) => [`${found.kind}:${found.relation}.${found.name}`, found]));
  for (const [kind, problems] of Object.entries(DEFINITION_PROBLEMS)) {
    const pinned: Record<string, Record<string, string>> = MEMBER_MONEY_DATABASE_SHAPE[kind as keyof typeof DEFINITION_PROBLEMS];
    for (const [relation, digests] of Object.entries(pinned)) {
      for (const [name, digest] of Object.entries(digests)) {
        const found = definitions.get(`${kind}:${relation}.${name}`);
        if (!found?.usable) findings.push({ identity: `${relation}.${name}`, problem: problems.unusable });
        else if (found.digest !== digest) findings.push({ identity: `${relation}.${name}`, problem: problems.changed });
      }
    }
  }

  const privilege = z.object({ exempt: z.boolean() }).parse((await client.query(`
    SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1), false)
      OR NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(name)
        WHERE pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
          WHERE oid = to_regclass(format('public.%I', t.name)))) IS DISTINCT FROM $1) AS exempt
  `, [appRole, [...MEMBER_MONEY_RELATIONS]])).rows[0]);
  const grantCheck: MemberMoneyGrantCheck = privilege.exempt ? "not_applicable" : "checked";

  if (grantCheck === "checked") {
    const grants = await client.query(`
      SELECT t.name AS identity, 'unsafe_application_grants' AS problem
      FROM unnest($2::text[]) AS t(name)
      WHERE NOT has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'SELECT')
         OR NOT has_table_privilege($1, to_regclass(format('public.%I', t.name)), 'INSERT')
         OR has_table_privilege($1, to_regclass(format('public.%I', t.name)), '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
         OR has_any_column_privilege($1, to_regclass(format('public.%I', t.name)), 'UPDATE')
    `, [appRole, [...MEMBER_MONEY_RELATIONS]]);
    findings.push(...z.array(Finding).parse(grants.rows));
  }
  return { findings, grantCheck };
}
