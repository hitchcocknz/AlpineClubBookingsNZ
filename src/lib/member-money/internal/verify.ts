import type { Client } from "pg";
import { z } from "zod";
import { APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES } from "../../database-roles";
import { MEMBER_MONEY_RELATIONS } from "../../member-money-tables";

const Finding = z.object({ identity: z.string(), problem: z.string() });

/** Operator-only evidence query. Run inside a read-only repeatable-read snapshot. */
export async function verifyMemberMoneyJournal(client: Client, appRole: string) {
  const batches = await client.query(`
    SELECT j.id AS identity, unnest(public.member_money_batch_errors(j.id)) AS problem
    FROM public."MemberMoneyJournal" j
    UNION ALL
    SELECT e.id, 'missing_journal' FROM public."MemberMoneyEvent" e
    LEFT JOIN public."MemberMoneyJournal" j ON j."eventId" = e.id WHERE j.id IS NULL
  `);
  const findings = z.array(Finding).parse(batches.rows);
  for (const table of MEMBER_MONEY_RELATIONS) {
    const result = await client.query(`
      SELECT $1::text AS identity, 'unsafe_application_grants' AS problem
      WHERE NOT has_table_privilege($2, to_regclass(format('public.%I', $1)), 'SELECT')
         OR NOT has_table_privilege($2, to_regclass(format('public.%I', $1)), 'INSERT')
         OR has_table_privilege($2, to_regclass(format('public.%I', $1)), '${APPEND_ONLY_FORBIDDEN_TABLE_PRIVILEGES}')
         OR has_any_column_privilege($2, to_regclass(format('public.%I', $1)), 'UPDATE')
      UNION ALL
      SELECT $1, 'missing_or_disabled_trigger'
      WHERE (SELECT count(*) FROM pg_trigger
        WHERE tgrelid = to_regclass(format('public.%I', $1))
          AND tgname IN ('member_money_immutable', 'member_money_no_truncate', 'member_money_complete')
          AND tgenabled = 'O'
          AND (tgname <> 'member_money_complete' OR (tgdeferrable AND tginitdeferred))) <> 3
      UNION ALL
      SELECT $1, 'missing_or_disabled_seal'
      WHERE $1 IN ('MemberMoneyJournal', 'MemberMoneyLine', 'MemberMoneyObligation', 'MemberMoneyApplication')
        AND NOT EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass(format('public.%I', $1))
            AND tgname = 'member_money_seal' AND tgenabled = 'O')
    `, [table, appRole]);
    findings.push(...z.array(Finding).parse(result.rows));
  }
  return findings;
}
