import type { DataMigrationVerification } from "./types";

/**
 * #4031 — the starter privacy policy's audit-log retention line.
 *
 * The migration chain plants the starter `privacy` PageContent row; #1945 last
 * rewrote it. Its section 7 said "System audit logs: Retained for 90 days, then
 * automatically pruned", which is not the schedule the code runs. This
 * migration replaces the whole row's `contentHtml` with the corrected starter
 * copy, but only where the row still equals the exact #1945 text (owner
 * decision, 16 Oct 2026). A privacy page an admin edited, even by appending a
 * line, keeps its own text byte for byte.
 *
 * No seed for the first case: the pre-state is whatever the migration chain
 * itself produces.
 */
const OLD_LINE = "<li><strong>System audit logs:</strong> Retained for 90 days, then automatically pruned.</li>";
const NEW_MARKER = "An entry kept as evidence of an incident is kept, with its IP address and browser details, for at least 10 years.";
const CLUB_NOTE = "<p>Our club also keeps paper sign-in sheets for one season.</p>";

const sectionState = `
  SELECT
    position('${OLD_LINE}' IN "contentHtml") > 0 AS "oldLine",
    position('${NEW_MARKER}' IN "contentHtml") > 0 AS "newSchedule"
  FROM "PageContent" WHERE "slug" = 'privacy'
`;

const verification: DataMigrationVerification = {
  migration: "20261118010000_correct_starter_privacy_audit_retention",
  intent:
    "Replace the untouched starter privacy page with the copy stating the real audit-log retention schedule, and leave a privacy page a club edited untouched.",
  idempotentReRun: true,
  cases: [
    {
      name: "a fresh install, carrying the starter privacy page the migration chain planted",
      seed: "",
      expectations: [
        {
          claim: "section 7 no longer says audit logs are pruned after 90 days; it states the class-by-class schedule",
          sql: sectionState,
          rows: [{ oldLine: false, newSchedule: true }],
        },
        {
          claim: "the privacy row itself survives — the update rewrites a field, it never deletes the page",
          sql: `SELECT count(*)::int AS "rows" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ rows: 1 }],
        },
      ],
    },
    {
      name: "a club that edited its privacy page by appending its own note",
      seed: `
        UPDATE "PageContent"
        SET "contentHtml" = "contentHtml" || '${CLUB_NOTE}'
        WHERE "slug" = 'privacy';
      `,
      expectations: [
        {
          claim: "the club's own page is untouched — equality on the whole previous text, so an edited page never matches",
          sql: sectionState,
          rows: [{ oldLine: true, newSchedule: false }],
        },
        {
          claim: "the club's own addition is still there",
          sql: `SELECT position('${CLUB_NOTE}' IN "contentHtml") > 0 AS "kept" FROM "PageContent" WHERE "slug" = 'privacy'`,
          rows: [{ kept: true }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "invert the WHERE (= becomes <>)",
      harm:
        "Rewrites every edited privacy page with the starter copy and leaves the untouched starter page still making the wrong 90-day promise.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" <> $previous$`,
    },
    {
      name: "drop the value guard, keeping only the slug",
      harm:
        "Overwrites every club's privacy page, including pages an admin wrote for their own club — silent loss of a club's legal text.",
      find: `AND "contentHtml" = $previous$`,
      replace: `AND "contentHtml" LIKE '%' OR "contentHtml" = $previous$`,
    },
  ],
};

export default verification;
