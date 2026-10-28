/** M1 contracts against the shipped migration and provisioning, never mock SQL. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDatabaseRolesSql } from "@/lib/database-roles";
import { MEMBER_MONEY_RELATIONS } from "@/lib/member-money-tables";
import { verifyMemberMoneyJournal } from "@/lib/member-money";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const prefix = `mm4513_${randomBytes(5).toString("hex")}`;
const roles = { migrator: `${prefix}_migration`, app: `${prefix}_app`, retention: `${prefix}_retention` };
let admin: Client;
let db: Client;
let app: Client;
let sequence = 0;
const next = () => `${prefix}_${++sequence}`;

// All economic instants come from the shared frozen clock, including SQL fixtures.
async function event(c: Client, id: string, kind = "RECEIPT") {
  await c.query(`INSERT INTO "MemberMoneyEvent"
    (id,"eventKey",kind,origin,"sourceIdentity","sourceVersion","payloadHash",reason,"effectiveAt","recordedAt")
    VALUES ($1,$1,$2,'OFFICER',$1,'v1',$3,'test evidence',$4,$4)`,
  [id, kind, "a".repeat(64), FROZEN_TEST_CLOCK_BASE_ISO]);
}
async function header(c: Client, id: string, count = 2, reversal: string | null = null, currency = "NZD") {
  await c.query(`INSERT INTO "MemberMoneyJournal"
    (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","reversesJournalId")
    VALUES ($1,$1,$2,'policy-1','coding-1',$3,$4)`, [id, currency, count, reversal]);
}
async function source(c: Client, id: string) {
  await c.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
    VALUES ($1,$1,'OFFICER_FACT',$1,'v1')`, [id]);
}
async function line(c: Client, batch: string, side: string, amount = 100, original: string | null = null) {
  const id = next();
  await c.query(`INSERT INTO "MemberMoneyLine"
    (id,"journalId","sourceLinkId",account,side,"amountCents","memberId",evidence,"originalLineId")
    VALUES ($1,$2,$2,'BANK',$3,$4,'member-evidence','{}',$5)`, [id, batch, side, amount, original]);
  return id;
}
async function batch(c: Client, id = next()) {
  await event(c, id);
  await header(c, id);
  await source(c, id);
  const debit = await line(c, id, "DEBIT");
  const credit = await line(c, id, "CREDIT");
  return { id, debit, credit };
}
async function bridge(c: Client, batchId: string, lineId: string, legacy: string) {
  const link = next();
  await c.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion","bookingLedgerLineId")
    VALUES ($1,$2,'BOOKING_LEDGER',$3,'v1',$3)`, [link,batchId,legacy]);
  await c.query(`INSERT INTO "MemberMoneySourcePosting" (id,"journalId","sourceLinkId","lineId")
    VALUES ($1,$2,$3,$4)`, [next(),batchId,link,lineId]);
}
async function transaction(c: Client, run: () => Promise<unknown>) {
  await c.query("BEGIN");
  try { await run(); await c.query("COMMIT"); }
  catch (error) { await c.query("ROLLBACK"); throw error; }
}

describe.skipIf(!RUN)("member money journal database contracts (#4513)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(url, "member money journal");
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${prefix}"`);
    const ownUrl = new URL(url); ownUrl.pathname = `/${prefix}`;
    db = new Client({ connectionString: ownUrl.toString() }); await db.connect();
    // Apply the actual additive migration in isolation, with only its legacy FK parents.
    // Full-history/migration-role rehearsal belongs to database-roles.realdb.test.ts.
    await db.query(`CREATE TABLE "Lodge" (id text PRIMARY KEY);
      CREATE TABLE "Booking" (id text PRIMARY KEY, "lodgeId" text REFERENCES "Lodge"(id));
      CREATE TABLE "BookingLedgerLine" (id text PRIMARY KEY);
      CREATE TABLE "AuditLog" (id text PRIMARY KEY, "ipAddress" text, "userAgent" text)`);
    await db.query(readFileSync("prisma/migrations/20261127010000_member_money_journal/migration.sql", "utf8"));
    const statements = buildDatabaseRolesSql({ databaseName: prefix,
      migrator: { roleName: roles.migrator, password: "m".repeat(28) },
      app: { roleName: roles.app, password: "a".repeat(28) },
      auditRetention: { roleName: roles.retention, password: "r".repeat(28) } });
    await transaction(db, async () => { for (const statement of statements) await db.query(statement); });
    ownUrl.username = roles.app; ownUrl.password = "a".repeat(28);
    app = new Client({ connectionString: ownUrl.toString() }); await app.connect();
  }, 30_000);
  afterAll(async () => {
    await app?.end(); await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${prefix}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  });

  it("commits a balanced complete batch as the INSERT/SELECT-only role and verifies it", async () => {
    await transaction(app, () => batch(app));
    expect(await verifyMemberMoneyJournal(app, roles.app)).toEqual([]);
  });

  it.each(MEMBER_MONEY_RELATIONS)("refuses direct UPDATE, DELETE and TRUNCATE of %s", async (table) => {
    // No predicate or matching row is needed: PostgreSQL refuses the privilege itself.
    for (const sql of [`UPDATE "${table}" SET id = id`, `DELETE FROM "${table}"`, `TRUNCATE "${table}"`]) {
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
      // Even an unrestricted operator cannot accidentally mutate posted rows.
      if (table === "MemberMoneyLine" && !sql.startsWith("TRUNCATE")) await expect(db.query(sql)).rejects.toMatchObject({ code: "23514" });
    }
    await expect(db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed`, [roles.retention, `"${table}"`]))
      .resolves.toMatchObject({ rows: [{ allowed: false }] });
  });

  it("refuses operator TRUNCATE even on an empty leaf relation", async () => {
    await expect(db.query(`TRUNCATE "MemberMoneySourcePosting"`)).rejects.toMatchObject({ code: "23514" });
  });

  it("stamps the real creating transaction even if SQL supplies a forged one", async () => {
    await transaction(app, async () => {
      const id = next(); await event(app,id,"ZERO");
      await app.query(`INSERT INTO "MemberMoneyJournal" (id,"eventId",currency,"policyVersion","codingVersion","expectedLineCount","creatingTransaction")
        VALUES ($1,$1,'NZD','policy-1','coding-1',0,0)`, [id]);
      await source(app,id);
      expect((await app.query(`SELECT "creatingTransaction" = txid_current() AS stamped FROM "MemberMoneyJournal" WHERE id=$1`, [id])).rows)
        .toEqual([{ stamped: true }]);
    });
  });

  it("refuses a balanced pair appended after commit and denies rewriting its transaction stamp", async () => {
    let id = "";
    await transaction(app, async () => { id = (await batch(app)).id; });
    await expect(transaction(app, async () => {
      await line(app, id, "DEBIT"); await line(app, id, "CREDIT");
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("sealed") });
    // An explicit old creatingTransaction cannot overwrite the database's stamp.
    const newer = next();
    await transaction(app, async () => {
      await event(app, newer); await header(app, newer); await source(app, newer);
      await line(app, newer, "DEBIT"); await line(app, newer, "CREDIT");
    });
    await expect(app.query(`UPDATE "MemberMoneyJournal" SET "creatingTransaction" = txid_current() WHERE id=$1`, [id]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it.each(["unbalanced", "incomplete", "missing source", "one leg", "zero with legs", "nonzero without legs"])("rejects %s at commit and rolls back the event", async (problem) => {
    const id = next();
    await expect(transaction(app, async () => {
      await event(app, id, ["zero with legs", "missing source"].includes(problem) ? "ZERO" : "RECEIPT");
      await header(app, id, problem === "one leg" ? 1 : ["nonzero without legs", "missing source"].includes(problem) ? 0 : 2);
      if (problem !== "missing source") await source(app, id);
      // Missing source gets FK-safe lines via another link in no case: zero lines still fails mandatory-link.
      if (!["missing source", "nonzero without legs"].includes(problem)) {
        await line(app, id, "DEBIT");
        if (!["incomplete", "one leg"].includes(problem)) await line(app, id, "CREDIT", problem === "unbalanced" ? 99 : 100);
      }
    })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining(
      problem === "missing source" ? "missing_source_link" : problem === "incomplete" ? "incomplete_batch"
        : problem === "unbalanced" ? "unbalanced_batch" : "invalid_zero_event",
    ) });
    expect((await app.query(`SELECT id FROM "MemberMoneyEvent" WHERE id=$1`, [id])).rows).toEqual([]);
  });

  it("rejects an orphan event and accepts an explicit zero event with a source", async () => {
    await expect(transaction(app, () => event(app, next()))).rejects.toMatchObject({ code: "23514" });
    await transaction(app, async () => {
      const id = next(); await event(app, id, "ZERO"); await header(app, id, 0); await source(app, id);
    });
  });

  it("refuses nonpositive cents and invalid tax evidence", async () => {
    for (const amount of [0, -1]) await expect(transaction(app, async () => {
      const id = next(); await event(app, id); await header(app, id); await source(app, id);
      await line(app, id, "DEBIT", amount);
    })).rejects.toMatchObject({ code: "23514" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence,"grossCents","netCents","taxCents","taxCode")
        VALUES ($1,$2,$2,'BANK','DEBIT',100,'{}',100,90,11,'tax')`, [next(), b.id]);
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses cross-batch source links, duplicate event/source keys and invalid bridge identity", async () => {
    let original = ""; await transaction(app, async () => { original = (await batch(app)).id; });
    await expect(transaction(app, () => event(app, original))).rejects.toMatchObject({ code: "23505" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
        VALUES ($1,$2,'OFFICER_FACT',$3,'v1')`, [next(), b.id, original]);
    })).rejects.toMatchObject({ code: "23505" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence)
        VALUES ($1,$2,$3,'BANK','DEBIT',1,'{}')`, [next(), b.id, original]);
    })).rejects.toMatchObject({ code: "23503" });
    await expect(transaction(app, async () => {
      const b = await batch(app);
      await app.query(`INSERT INTO "MemberMoneySourceLink" (id,"journalId","sourceKind","sourceId","sourceVersion")
        VALUES ($1,$2,'BOOKING_LEDGER','missing','v1')`, [next(), b.id]);
    })).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts only exact reversals and refuses a second reversal", async () => {
    let original!: Awaited<ReturnType<typeof batch>>;
    await transaction(app, async () => { original = await batch(app); });
    const reverse = async (amount = 100) => transaction(app, async () => {
      const id = next(); await event(app, id, "REVERSAL"); await header(app, id, 2, original.id); await source(app, id);
      await line(app, id, "CREDIT", amount, original.debit); await line(app, id, "DEBIT", amount, original.credit);
    });
    await expect(reverse(99)).rejects.toMatchObject({ code: "23514" });
    await reverse();
    await expect(reverse()).rejects.toMatchObject({ code: "23505" });
  });

  it("requires exact member/currency applications and exact, unique application reversals", async () => {
    let receipt!: Awaited<ReturnType<typeof batch>>;
    const obligation = next(), otherObligation = next();
    await transaction(app, async () => {
      receipt = await batch(app);
      await app.query(`INSERT INTO "MemberMoneyObligation" (id,"journalId","obligationKey",kind,"memberId","faceCents",evidence)
        VALUES ($1,$2,$1,'CHARGE','member-evidence',100,'{}')`, [obligation,receipt.id]);
      await app.query(`INSERT INTO "MemberMoneyObligation" (id,"journalId","obligationKey",kind,"memberId","faceCents",evidence)
        VALUES ($1,$2,$1,'CHARGE','another-member',100,'{}')`, [otherObligation,receipt.id]);
    });
    const apply = async (amount: number, reversal: string | null = null, currency = "NZD", target = obligation) => {
      const application = next();
      await transaction(app, async () => {
        const id = next(); await event(app,id); await header(app,id,2,null,currency); await source(app,id);
        await line(app,id,"DEBIT"); await line(app,id,"CREDIT");
        await app.query(`INSERT INTO "MemberMoneyApplication" (id,"applicationKey","journalId","sourceLineId","obligationId","amountCents","reversesApplicationId")
          VALUES ($1,$1,$2,$3,$4,$5,$6)`, [application,id,receipt.debit,target,amount,reversal]);
      });
      return application;
    };
    await expect(apply(100,null,"USD")).rejects.toMatchObject({ code: "23514" });
    await expect(apply(100,null,"NZD",otherObligation)).rejects.toMatchObject({ code: "23514" });
    const first = await apply(100);
    await expect(apply(99,first)).rejects.toMatchObject({ code: "23514" });
    await apply(100,first);
    await expect(apply(100,first)).rejects.toMatchObject({ code: "23505" });
    await expect(app.query(`INSERT INTO "MemberMoneyObligation" (id,"journalId","obligationKey",kind,"memberId","faceCents",evidence)
      VALUES ($1,$2,$1,'CHARGE','member-evidence',100,'{}')`, [next(),receipt.id]))
      .rejects.toMatchObject({ code: "23514", message: expect.stringContaining("sealed") });
  });

  it("lets a late compatibility link attach without allowing another leg", async () => {
    let original!: Awaited<ReturnType<typeof batch>>;
    await transaction(app, async () => { original = await batch(app); });
    const legacy = next(); await db.query(`INSERT INTO "BookingLedgerLine" VALUES ($1)`, [legacy]);
    await transaction(app, () => bridge(app,original.id,original.debit,legacy));
    await expect(line(app,original.id,"DEBIT")).rejects.toMatchObject({ code: "23514" });
  });

  it("reports disabled enforcement rather than a false green on valid balances", async () => {
    await db.query(`ALTER TABLE "MemberMoneyLine" DISABLE TRIGGER member_money_seal`);
    try {
      expect(await verifyMemberMoneyJournal(app, roles.app)).toContainEqual({ identity: "MemberMoneyLine", problem: "missing_or_disabled_seal" });
    } finally { await db.query(`ALTER TABLE "MemberMoneyLine" ENABLE TRIGGER member_money_seal`); }
    expect(await verifyMemberMoneyJournal(app, roles.app)).toEqual([]);
  });

  it("retains bridged legacy evidence and booking/lodge parents with RESTRICT", async () => {
    const booking = next(), lodge = next(), legacy = next();
    await db.query(`INSERT INTO "Lodge" VALUES ($1)`, [lodge]);
    await db.query(`INSERT INTO "Booking" VALUES ($1,$2)`, [booking, lodge]);
    await db.query(`INSERT INTO "BookingLedgerLine" VALUES ($1)`, [legacy]);
    await transaction(app, async () => {
      const b = await batch(app);
      await bridge(app,b.id,b.debit,legacy);
    });
    await expect(db.query(`DELETE FROM "BookingLedgerLine" WHERE id=$1`, [legacy])).rejects.toMatchObject({ code: "23503" });
    // A valid lodge-scoped line on a new batch retains both its parents.
    await transaction(app, async () => {
      const id = next(); await event(app,id); await header(app,id); await source(app,id);
      await app.query(`INSERT INTO "MemberMoneyLine" (id,"journalId","sourceLinkId",account,side,"amountCents",evidence,"bookingId","lodgeId")
        VALUES ($1,$2,$2,'BANK','DEBIT',100,'{}',$3,$4)`, [next(),id,booking,lodge]);
      await line(app,id,"CREDIT");
    });
    for (const [table, id] of [["Booking",booking],["Lodge",lodge]]) {
      await expect(db.query(`DELETE FROM "${table}" WHERE id=$1`, [id])).rejects.toMatchObject({ code: "23503" });
      await expect(db.query(`UPDATE "${table}" SET id=$1 WHERE id=$2`, [next(),id])).rejects.toMatchObject({ code: "23503" });
    }
  });
});
