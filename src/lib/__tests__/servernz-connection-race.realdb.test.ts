/**
 * #4436: real request builders and connection writers, forced in both orders.
 * No HTTP leaves this process. The shared race harness imports this suite;
 * ordinary unit runs skip it. Singleton fixtures are owned sequentially with
 * the #4366 suite, and only the guarded disposable race database is accepted.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OLD_URL = "https://old.race-4436.example.invalid";
const NEW_URL = "https://new.race-4436.example.invalid";
const OLD_KEY = "race-4436-old-key";
const ACTOR_ID = "race-4436-admin";
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let settings: typeof import("@/lib/servernz-settings");
let config: typeof import("@/lib/servernz-config");
let api: typeof import("@/lib/servernz-api");
let observer: PrismaClient;
const savedAuthSecret = process.env.AUTH_SECRET;
const fetchMock = vi.fn();

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

(RUN ? describe : describe.skip)("central-server address move versus sync — real PostgreSQL (#4436)", { timeout: 60_000 }, () => {
  async function clean() {
    await prisma.auditLog.deleteMany({ where: { memberId: ACTOR_ID } });
    await prisma.integrationCredential.deleteMany({ where: { provider: "servernz", key: "api_key" } });
    await prisma.serverNzSettings.deleteMany({ where: { id: "default" } });
  }

  async function waitForBlockedConnection() {
    const start = process.hrtime.bigint();
    while (true) {
      // An observation, not a row-lock read; there is no Prisma model for this view.
      const rows = await observer.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
      `;
      if ((rows[0]?.count ?? 0) > 0) return;
      if (realElapsedMs(start) > 10_000) throw new Error("The competing connection never queued on the settings fence.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function moveAddress(pause?: ReturnType<typeof latch>, entered?: ReturnType<typeof latch>) {
    return config.withServerNzConnectionTransaction(async (tx) => {
      await settings.updateServerNzSettings({ baseUrl: NEW_URL, updatedByMemberId: ACTOR_ID }, tx);
      entered?.release();
      if (pause) await pause.promise;
      await config.clearServerNzApiKey({ kind: "admin", memberId: ACTOR_ID }, tx);
    });
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Central-server connection");
    process.env.DATABASE_URL = RACE_DB_URL;
    process.env.AUTH_SECRET = "race4436Only_8be1c649fd2a704e95c03d7fa86210bd";
    ({ prisma } = await import("@/lib/prisma"));
    settings = await import("@/lib/servernz-settings");
    config = await import("@/lib/servernz-config");
    api = await import("@/lib/servernz-api");
    const [{ PrismaClient: Client }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"), import("@/lib/prisma-adapter"),
    ]);
    observer = new Client({ adapter: createPrismaPgAdapter(RACE_DB_URL) });
    await observer.$connect();
  });

  beforeEach(async () => {
    await clean();
    const { encryptCredential, INTEGRATION_CREDENTIAL_LABEL } = await import("@/lib/integration-crypto");
    await prisma.serverNzSettings.create({ data: {
      id: "default", baseUrl: OLD_URL, serverVersion: "2.1", otherLodgesOwnedNames: ["Old lodge"],
    } });
    await prisma.integrationCredential.create({ data: {
      provider: "servernz", key: "api_key",
      ...encryptCredential({ provider: "servernz", key: "api_key", plaintext: OLD_KEY, label: INTEGRATION_CREDENTIAL_LABEL }),
    } });
    const { resetIntegrationCredentialCacheForTests, resolveIntegrationCredential } = await import("@/lib/integration-credentials");
    resetIntegrationCredentialCacheForTests();
    // Warm the old process-local cache: a fenced read must bypass it.
    expect(await resolveIntegrationCredential("servernz", "api_key")).toMatchObject({ value: OLD_KEY });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ lodges: [], cursor: null, count: 0 })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    try {
      if (prisma) await clean();
      await observer?.$disconnect();
    } finally {
      if (savedAuthSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuthSecret;
      vi.unstubAllGlobals();
    }
  });

  it("finishes an old-connection sync before allowing the address and key to move", async () => {
    const readAddress = latch();
    const resumeReader = latch();
    const originalLoad = settings.loadServerNzSettings;
    const read = vi.spyOn(settings, "loadServerNzSettings").mockImplementationOnce(async (db) => {
      const value = await originalLoad(db);
      readAddress.release();
      await resumeReader.promise;
      return value;
    });
    const sync = api.pullOtherLodges();
    let move: Promise<void> | undefined;
    try {
      await Promise.race([readAddress.promise, sync.then(() => { throw new Error("Sync escaped the read barrier."); })]);
      move = moveAddress();
      await waitForBlockedConnection();
      resumeReader.release();
      await sync;
      await move;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(`${OLD_URL}/api/v1/other-lodges`);
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${OLD_KEY}`);
      await expect(api.pullOtherLodges()).rejects.toBeInstanceOf(api.ServerNzNotConfiguredError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      resumeReader.release();
      read.mockRestore();
      await Promise.allSettled([sync, move]);
    }
  });

  it("serialises initial setup when the singleton is absent", async () => {
    await prisma.serverNzSettings.delete({ where: { id: "default" } });
    const [move, sync] = await Promise.allSettled([moveAddress(), api.pullOtherLodges()]);
    expect(move.status).toBe("fulfilled");
    expect(sync.status).toBe("rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for an address change in flight and sends no old key to the new address", async () => {
    const changedAddress = latch();
    const resumeWriter = latch();
    const move = moveAddress(resumeWriter, changedAddress);
    let sync: Promise<unknown> | undefined;
    try {
      await Promise.race([changedAddress.promise, move.then(() => { throw new Error("Move escaped the write barrier."); })]);
      sync = api.pullOtherLodges();
      // Attach the rejection handler immediately so cleanup cannot leak a rejection.
      const refused = expect(sync).rejects.toBeInstanceOf(api.ServerNzNotConfiguredError);
      await waitForBlockedConnection();
      expect(fetchMock).not.toHaveBeenCalled();
      resumeWriter.release();
      await move;
      await refused;
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await prisma.integrationCredential.count({ where: { provider: "servernz", key: "api_key" } })).toBe(0);
      expect(await prisma.serverNzSettings.findUnique({ where: { id: "default" } })).toMatchObject({
        baseUrl: NEW_URL, serverVersion: null, otherLodgesOwnedNames: null,
      });
    } finally {
      resumeWriter.release();
      await Promise.allSettled([move, sync]);
    }
  });
});
