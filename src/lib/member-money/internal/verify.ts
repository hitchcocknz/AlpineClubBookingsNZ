import type { Client } from "pg";
import { z } from "zod";
import { APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES } from "../../database-roles";
import { MEMBER_MONEY_RELATIONS, MEMBER_MONEY_SEALED_RELATIONS } from "../../member-money-tables";
import { MEMBER_MONEY_DATABASE_SHAPE } from "./database-shape";

const Finding = z.object({ identity: z.string(), problem: z.string() });
export type MemberMoneyFinding = z.infer<typeof Finding>;

/**
 * `checked`: the role's effective table rights were compared with INSERT/SELECT.
 * `not_applicable`: the role is a superuser or owns every journal relation, as
 * on a single-role install, where no grant can narrow it (`INV-OPS-016`).
 */
export type MemberMoneyGrantCheck = "checked" | "not_applicable";

/** Triggers count as enforcing when they fire for ordinary sessions: Origin or Always. */
const ENABLED = `tgenabled IN ('O', 'A')`;

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

  const privilege = z.object({ exempt: z.boolean() }).parse((await client.query(`
    SELECT coalesce((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = $1), false)
      OR NOT EXISTS (SELECT 1 FROM unnest($2::text[]) AS t(name)
        WHERE pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
          WHERE oid = to_regclass(format('public.%I', t.name)))) IS DISTINCT FROM $1) AS exempt
  `, [appRole, [...MEMBER_MONEY_RELATIONS]])).rows[0]);
  const grantCheck: MemberMoneyGrantCheck = privilege.exempt ? "not_applicable" : "checked";

  for (const table of MEMBER_MONEY_RELATIONS) {
    const result = await client.query(`
      SELECT $1::text AS identity, 'unsafe_application_grants' AS problem
      WHERE $3::boolean AND (NOT has_table_privilege($2, to_regclass(format('public.%I', $1)), 'SELECT')
         OR NOT has_table_privilege($2, to_regclass(format('public.%I', $1)), 'INSERT')
         OR has_table_privilege($2, to_regclass(format('public.%I', $1)), '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
         OR has_any_column_privilege($2, to_regclass(format('public.%I', $1)), 'UPDATE'))
      UNION ALL
      SELECT $1, 'missing_or_disabled_trigger'
      WHERE (SELECT count(*) FROM pg_trigger
        WHERE tgrelid = to_regclass(format('public.%I', $1))
          AND tgname IN ('member_money_immutable', 'member_money_no_truncate', 'member_money_complete')
          AND ${ENABLED}
          AND (tgname <> 'member_money_complete' OR (tgdeferrable AND tginitdeferred))) <> 3
      UNION ALL
      SELECT $1, 'missing_or_disabled_seal'
      WHERE $1 = ANY($4::text[])
        AND NOT EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(format('public.%I', $1))
            AND tgname = 'member_money_seal' AND ${ENABLED})
      UNION ALL
      SELECT $1 || '.' || expected.name, 'missing_or_unvalidated_constraint'
      FROM unnest($5::text[]) AS expected(name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = to_regclass(format('public.%I', $1))
          AND c.conname = expected.name AND c.convalidated)
    `, [
      table,
      appRole,
      grantCheck === "checked",
      [...MEMBER_MONEY_SEALED_RELATIONS],
      [...MEMBER_MONEY_DATABASE_SHAPE.constraints[table]],
    ]);
    findings.push(...z.array(Finding).parse(result.rows));
  }
  return { findings, grantCheck };
}
