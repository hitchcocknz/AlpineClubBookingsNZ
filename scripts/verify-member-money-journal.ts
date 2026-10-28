/** Read-only verifier; no posting, backfill or provider access. */
import { Client } from "pg";
import { z } from "zod";
import { MEMBER_MONEY_ACCOUNTS, verifyMemberMoneyJournal } from "../src/lib/member-money";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required (use the application connection).");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const role = z.object({ current_user: z.string() }).parse((await client.query("SELECT current_user")).rows[0]);
    const findings = await verifyMemberMoneyJournal(client, process.env.APP_DB_USER ?? role.current_user);
    await client.query("COMMIT");
    console.log(JSON.stringify({ accounts: Object.keys(MEMBER_MONEY_ACCOUNTS).length, findings }, null, 2));
    if (findings.length) process.exitCode = 1;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}
main().catch((error: unknown) => {
  // Never print a connection string or economic evidence in CLI errors.
  console.error(error instanceof Error ? error.message : "Journal verification failed");
  process.exitCode = 1;
});
