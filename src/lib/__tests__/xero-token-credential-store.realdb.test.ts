/**
 * Real-PostgreSQL proof of the Xero token store (#3454), as #3806 R2 left it:
 * the refresh lease and the connection on `XeroConnection`, the tokens only in
 * the credential store, and the `XeroToken` row kept for the previous release.
 *
 * The unit suite (`xero-token-credential-store.test.ts`) proves the audit
 * contract and the rules against a stateful double. What a double cannot prove
 * is what PostgreSQL does — with two writers at once, and with the trigger the
 * R2 migration installs — and that is what keeps a rotating refresh token from
 * being spent twice:
 *
 *   - two processes claiming the refresh lease AT THE SAME TIME — this code
 *     against itself, and this code against the previous release (#3454), which
 *     claims `XeroToken.refreshInProgressUntil` with its own statement — let
 *     exactly one through;
 *   - a claim takes BOTH leases or neither (#3806 D1: R2 claims both while the
 *     #3454 code can run);
 *   - after every R2 write the `XeroToken` row is present with its non-secret
 *     columns current, and the #3454 code's own read takes the store copy, so
 *     the two releases never disagree about the live refresh token;
 *   - the #3454 code's connect, refresh and disconnect reach R2 through the
 *     trigger;
 *   - a refresh whose store compare-and-set loses rolls everything back.
 *
 * The previous release is `support/xero-3454-release.ts`: its statements, as
 * raw SQL, because the R2 client cannot name the ciphertext columns.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it. `XeroToken` is a singleton
 * table nothing else in that harness uses; this file clears it and its own
 * `xero-oauth` credential row before and after.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-token-credential-store.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as raceDbUrl from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 20_000;
const TEMP_AUTH_SECRET = "race-3454-auth-secret-0123456789abcdefghijklmnop";

/** Keep the existing entry point; INV-SSOT-004 gives the safety policy one home. */
export function assertSafeXeroTokenRaceDbUrl(url: string): void {
  raceDbUrl.assertSafeRaceDbUrl(url, "Xero token store");
}

describe("Xero token race DB safety guard (#3454)", () => {
  it("propagates the canonical safety refusal (#4175, INV-SSOT-004)", () => {
    const url = "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881";
    const refusal = new Error("synthetic canonical safety refusal");
    const guard = vi.spyOn(raceDbUrl, "assertSafeRaceDbUrl").mockImplementationOnce(() => {
      throw refusal;
    });
    try {
      expect(() => assertSafeXeroTokenRaceDbUrl(url)).toThrow(refusal);
      expect(guard).toHaveBeenCalledExactlyOnceWith(url, "Xero token store");
    } finally {
      guard.mockRestore();
    }
  });

  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafeXeroTokenRaceDbUrl("postgresql://u:p@127.0.0.1:55442/concurrency_race_1881"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.example.org:55442/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafeXeroTokenRaceDbUrl(url)).toThrow();
  });
});

type CapturedAuthSecret = { value: string | undefined };

/** The actual setup boundary, exercised without importing or connecting to Prisma. */
function setUpXeroTokenRaceEnvironment(url: string): CapturedAuthSecret {
  assertSafeXeroTokenRaceDbUrl(url);
  process.env.DATABASE_URL = url;
  const savedAuthSecret = { value: process.env.AUTH_SECRET };
  // The token store refuses to encrypt under a weak secret; this one is a
  // throwaway for a throwaway database.
  process.env.AUTH_SECRET = TEMP_AUTH_SECRET;
  return savedAuthSecret;
}

/** Also exercised without PostgreSQL, so cleanup failures cannot hide a secret leak. */
async function tearDownXeroTokenRaceSuite(
  savedAuthSecret: CapturedAuthSecret | undefined,
  cleanup: { tokens: () => Promise<unknown>; audit: () => Promise<unknown> } | undefined,
): Promise<void> {
  try {
    if (cleanup) {
      await cleanup.tokens();
      await cleanup.audit();
    }
  } finally {
    // Undefined means setup never captured the secret (for example, URL refusal).
    if (savedAuthSecret) {
      if (savedAuthSecret.value === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = savedAuthSecret.value;
    }
  }
}

describe("Xero token race setup and teardown restore AUTH_SECRET (#4164, #4174)", () => {
  let originalAuthSecret: string | undefined;
  let originalDatabaseUrl: string | undefined;

  beforeEach(() => {
    originalAuthSecret = process.env.AUTH_SECRET;
    originalDatabaseUrl = process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalAuthSecret;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  describe.each([undefined, "previous", ""])("previous secret %j", (previousSecret) => {
    beforeEach(() => {
      if (previousSecret === undefined) delete process.env.AUTH_SECRET;
      else process.env.AUTH_SECRET = previousSecret;
    });

    it.each(["", "postgresql://u:p@db.example.org:55442/concurrency_race_1881"])(
      "preserves the secret when setup rejects URL %j (#4174)",
      async (url) => {
        let savedAuthSecret: CapturedAuthSecret | undefined;
        expect(() => {
          savedAuthSecret = setUpXeroTokenRaceEnvironment(url);
        }).toThrow();
        expect(process.env.DATABASE_URL).toBe(originalDatabaseUrl);

        await tearDownXeroTokenRaceSuite(savedAuthSecret, undefined);

        expect(process.env.AUTH_SECRET).toBe(previousSecret);
        expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
      },
    );
    it.each(["tokens", "audit"] as const)("restores after %s cleanup rejects and preserves its error", async (failingStep) => {
      const savedAuthSecret = setUpXeroTokenRaceEnvironment(
        "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881",
      );
      expect(process.env.AUTH_SECRET).toBe(TEMP_AUTH_SECRET);
      const error = new Error(`${failingStep} cleanup failed`);
      const cleanup = {
        tokens: vi.fn(async () => {}),
        audit: vi.fn(async () => {}),
      };
      cleanup[failingStep].mockRejectedValueOnce(error);

      await expect(tearDownXeroTokenRaceSuite(savedAuthSecret, cleanup)).rejects.toBe(error);

      expect(process.env.AUTH_SECRET).toBe(previousSecret);
      expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
      expect(cleanup.tokens).toHaveBeenCalledOnce();
      expect(cleanup.audit).toHaveBeenCalledTimes(failingStep === "tokens" ? 0 : 1);
    });

    it("restores after successful cleanup", async () => {
      const savedAuthSecret = setUpXeroTokenRaceEnvironment(
        "postgresql://u:p@127.0.0.1:55442/concurrency_race_1881",
      );
      expect(process.env.AUTH_SECRET).toBe(TEMP_AUTH_SECRET);
      const cleanup = {
        tokens: vi.fn(async () => {}),
        audit: vi.fn(async () => {}),
      };

      await tearDownXeroTokenRaceSuite(savedAuthSecret, cleanup);

      expect(process.env.AUTH_SECRET).toBe(previousSecret);
      expect(Object.hasOwn(process.env, "AUTH_SECRET")).toBe(previousSecret !== undefined);
      expect(cleanup.tokens).toHaveBeenCalledOnce();
      expect(cleanup.audit).toHaveBeenCalledOnce();
    });
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let store: typeof import("@/lib/xero-token-store");
let credentials: typeof import("@/lib/integration-credentials");
let release3454: typeof import("./support/xero-3454-release");
let StaleCredentialWriteError: (typeof import("@/lib/integration-credential-actor"))["StaleCredentialWriteError"];
let previousAuthSecret: CapturedAuthSecret | undefined;

const ADMIN = { kind: "admin", memberId: "race-3454-admin" } as const;
const REFRESH_JOB = { kind: "system", actor: "xero-token-refresh" } as const;
const TENANT = "race-3806-tenant";

(RUN ? describe : describe.skip)(
  "Xero token store — real PostgreSQL (#3454, #3806 R2)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    async function clearTokens() {
      await prisma.xeroToken.deleteMany();
      await prisma.xeroConnection.deleteMany();
      await prisma.integrationCredential.deleteMany({
        where: { provider: store.XERO_OAUTH_TOKEN_PROVIDER },
      });
      credentials.resetIntegrationCredentialCacheForTests();
    }

    function tokens(tag: string, expiresInMs = 60_000) {
      return {
        accessToken: `race-3806-access-${tag}`,
        refreshToken: `race-3806-refresh-${tag}`,
        expiresAt: new Date(Date.now() + expiresInMs),
        tenantId: TENANT,
      };
    }

    async function connect(tag: string) {
      await store.saveXeroTokens(tokens(tag), { actor: ADMIN });
    }

    async function refreshWith(tag: string) {
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      await store.saveXeroTokens(tokens(tag, 1_800_000), {
        actor: REFRESH_JOB,
        lease: claim.lease,
      });
    }

    /** Both leases, as stored. */
    async function leases() {
      const [row] = await prisma.$queryRaw<{ lease: Date | null }[]>`
        SELECT "refreshInProgressUntil" AS "lease" FROM "XeroToken"`;
      const connection = await prisma.xeroConnection.findUnique({
        where: { id: "default" },
        select: { refreshInProgressUntil: true },
      });
      return {
        previousRelease: row?.lease?.getTime() ?? null,
        ours: connection?.refreshInProgressUntil?.getTime() ?? null,
      };
    }

    beforeAll(async () => {
      previousAuthSecret = setUpXeroTokenRaceEnvironment(RACE_DB_URL);
      ({ prisma } = await import("@/lib/prisma"));
      store = await import("@/lib/xero-token-store");
      credentials = await import("@/lib/integration-credentials");
      release3454 = await import("./support/xero-3454-release");
      ({ StaleCredentialWriteError } = await import("@/lib/integration-credential-actor"));
      await clearTokens();
    });

    beforeEach(async () => {
      await clearTokens();
    });

    afterAll(async () => {
      await tearDownXeroTokenRaceSuite(
        previousAuthSecret,
        prisma
          ? {
              tokens: clearTokens,
              audit: () => prisma.auditLog.deleteMany({
                where: {
                  entityId: {
                    in: [
                      `${store.XERO_OAUTH_TOKEN_PROVIDER}:${store.XERO_OAUTH_TOKEN_KEY}`,
                      "xero:token_key",
                    ],
                  },
                },
              }),
            }
          : undefined,
      );
    });

    // -----------------------------------------------------------------------
    // The dual lease (#3806 D1)
    // -----------------------------------------------------------------------

    it("lets exactly one of several simultaneous claims take the lease, and it holds BOTH halves", async () => {
      await connect("c1");

      const claims = await Promise.all(
        Array.from({ length: 6 }, () => store.claimXeroTokenRefreshLease()),
      );

      const winners = claims.filter((claim) => claim.claimed);
      expect(winners).toHaveLength(1);
      // Every loser was handed the same live tokens to wait on.
      for (const claim of claims) {
        expect(claim.tokens?.refreshToken).toBe("race-3806-refresh-c1");
      }
      const leaseUntil = winners[0]!.leaseUntil!.getTime();
      expect(await leases()).toEqual({ previousRelease: leaseUntil, ours: leaseUntil });
    });

    it("lets exactly one through when the previous release claims at the same time, every time", async () => {
      for (let round = 0; round < 8; round += 1) {
        await clearTokens();
        await connect(`c${round}`);
        const now = new Date();
        const lease = new Date(now.getTime() + 120_000);

        const [oldWon, ours] = await Promise.all([
          release3454.claim3454(prisma, now, lease),
          store.claimXeroTokenRefreshLease({ now }),
        ]);

        expect((oldWon ? 1 : 0) + (ours.claimed ? 1 : 0), `round ${round}`).toBe(1);
        if (oldWon) {
          // Losing to the previous release leaves no half lease behind.
          expect((await leases()).ours, `round ${round}`).toBeNull();
        }
      }
    });

    it("loses, and takes nothing, while the previous release holds its lease", async () => {
      await connect("c1");
      const now = new Date();
      expect(await release3454.claim3454(prisma, now, new Date(now.getTime() + 120_000))).toBe(true);

      const claim = await store.claimXeroTokenRefreshLease({ now });

      expect(claim.claimed).toBe(false);
      // The waiter sees the previous release's lease and waits on it.
      expect(claim.leaseUntil?.getTime()).toBe(now.getTime() + 120_000);
      expect((await leases()).ours).toBeNull();
    });

    it("gives the previous release's half back when its own lease is held elsewhere (never half a lease)", async () => {
      await connect("c1");
      const now = new Date();
      const elsewhere = new Date(now.getTime() + 120_000);
      // A holder of the XeroConnection lease alone: the shape the release that
      // retires XeroToken will have (R3).
      await prisma.xeroConnection.update({
        where: { id: "default" },
        data: { refreshInProgressUntil: elsewhere },
      });

      const claim = await store.claimXeroTokenRefreshLease({ now });

      expect(claim.claimed).toBe(false);
      expect(await leases()).toEqual({ previousRelease: null, ours: elsewhere.getTime() });
      // And the previous release can still take its lease: nothing was left held.
      expect(await release3454.claim3454(prisma, now, elsewhere)).toBe(true);
    });

    it("releases both halves", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");

      await store.releaseXeroTokenRefreshLease(claim.lease);

      expect(await leases()).toEqual({ previousRelease: null, ours: null });
    });

    // -----------------------------------------------------------------------
    // The XeroToken row stays present and the #3454 code reads the store copy
    // -----------------------------------------------------------------------

    it("a connect leaves the row the previous release needs, and that release reads the STORE copy", async () => {
      await connect("c1");

      const rows = await prisma.$queryRaw<
        { accessToken: string; refreshToken: string; tenantId: string | null }[]
      >`SELECT "accessToken", "refreshToken", "tenantId" FROM "XeroToken"`;
      expect(rows).toEqual([{ accessToken: "", refreshToken: "", tenantId: TENANT }]);

      const seen = await release3454.read3454(prisma);
      expect(seen).toMatchObject({
        source: "store",
        refreshToken: "race-3806-refresh-c1",
        tenantId: TENANT,
      });
      expect(await store.isXeroConnected()).toBe(true);
    });

    it("a refresh keeps the row current and the previous release still reads the store copy", async () => {
      await connect("c1");
      const before = await prisma.xeroToken.findFirstOrThrow({ select: { id: true } });

      await refreshWith("r1");

      const [row] = await prisma.$queryRaw<
        { id: string; accessToken: string; expiresAt: Date; lease: Date | null }[]
      >`SELECT "id", "accessToken", "expiresAt", "refreshInProgressUntil" AS "lease" FROM "XeroToken"`;
      const stored = await store.loadXeroTokens();
      expect(row).toMatchObject({ id: before.id, accessToken: "", lease: null });
      expect(row!.expiresAt.getTime()).toBe(stored!.expiresAt.getTime());
      expect(await release3454.read3454(prisma)).toMatchObject({
        source: "store",
        refreshToken: "race-3806-refresh-r1",
      });
      expect(await leases()).toEqual({ previousRelease: null, ours: null });
    });

    it("a reconnect over a row the previous release wrote replaces it, and that release follows", async () => {
      await release3454.connect3454(tokens("old"), ADMIN);
      expect((await release3454.read3454(prisma))?.source).toBe("store");

      await connect("c2");

      expect(await prisma.xeroToken.count()).toBe(1);
      expect(await release3454.read3454(prisma)).toMatchObject({
        source: "store",
        refreshToken: "race-3806-refresh-c2",
      });
    });

    // -----------------------------------------------------------------------
    // The previous release's writes reach R2 through the trigger
    // -----------------------------------------------------------------------

    it("sees the previous release's first connect, refresh and disconnect", async () => {
      await release3454.connect3454(tokens("old"), ADMIN);
      expect(await store.isXeroConnected()).toBe(true);
      expect((await store.loadXeroTokens())?.refreshToken).toBe("race-3806-refresh-old");

      const now = new Date();
      const lease = new Date(now.getTime() + 120_000);
      expect(await release3454.claim3454(prisma, now, lease)).toBe(true);
      const next = tokens("old-r1", 1_800_000);
      await release3454.save3454(next, lease, REFRESH_JOB);
      const connection = await prisma.xeroConnection.findUniqueOrThrow({
        where: { id: "default" },
      });
      expect(connection.expiresAt.getTime()).toBe(next.expiresAt.getTime());
      expect((await store.loadXeroTokens())?.refreshToken).toBe("race-3806-refresh-old-r1");

      await release3454.disconnect3454(ADMIN);
      expect(await store.isXeroConnected()).toBe(false);
      expect(await store.loadXeroTokens()).toBeNull();
    });

    it("refreshes alternating between the releases never spend a rotated token", async () => {
      // Xero's side: one live refresh token, rotated on every spend.
      let live = "race-3806-refresh-c1";
      let issued = 0;
      const spend = (refreshToken: string) => {
        if (refreshToken !== live) throw new Error(`invalid_grant: ${refreshToken} was rotated`);
        issued += 1;
        live = `race-3806-refresh-x${issued}`;
        return { ...tokens(`x${issued}`, 1_800_000), refreshToken: live };
      };
      await connect("c1");

      for (let round = 0; round < 3; round += 1) {
        // This release.
        const claim = await store.claimXeroTokenRefreshLease();
        if (!claim.claimed) throw new Error("R2 lost the lease");
        await store.saveXeroTokens(spend(claim.tokens.refreshToken), {
          actor: REFRESH_JOB,
          lease: claim.lease,
        });
        // The previous release, through its own read, claim and save.
        const seen = await release3454.read3454(prisma);
        const now = new Date();
        const lease = new Date(now.getTime() + 120_000);
        expect(await release3454.claim3454(prisma, now, lease)).toBe(true);
        await release3454.save3454(spend(seen!.refreshToken), lease, REFRESH_JOB);
      }

      expect((await store.loadXeroTokens())?.refreshToken).toBe(live);
      expect((await release3454.read3454(prisma))?.refreshToken).toBe(live);
    });

    // -----------------------------------------------------------------------
    // The save's fences
    // -----------------------------------------------------------------------

    it("rolls everything back when the store's compare-and-set loses, in a real transaction", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      // A writer that bypassed the lease replaced the store copy.
      await credentials.withCredentialTransaction(
        [store.XERO_OAUTH_TOKEN_PROVIDER],
        (tx) =>
          credentials.setIntegrationCredentialInTransaction({
            tx,
            provider: store.XERO_OAUTH_TOKEN_PROVIDER,
            key: store.XERO_OAUTH_TOKEN_KEY,
            value: "{}",
            actor: ADMIN,
            expect: { expect: "any" },
          }),
      );
      const rowBefore = await prisma.xeroToken.findFirstOrThrow();
      const connectionBefore = await prisma.xeroConnection.findFirstOrThrow();

      await expect(
        store.saveXeroTokens(tokens("refreshed", 1_800_000), {
          actor: REFRESH_JOB,
          lease: claim.lease,
        }),
      ).rejects.toBeInstanceOf(StaleCredentialWriteError);

      expect(await prisma.xeroToken.findFirstOrThrow()).toEqual(rowBefore);
      expect(await prisma.xeroConnection.findFirstOrThrow()).toEqual(connectionBefore);
      expect(await leases()).toEqual({
        previousRelease: claim.leaseUntil.getTime(),
        ours: claim.leaseUntil.getTime(),
      });
    });

    it("lets one of two simultaneous refresh saves under the same lease land, never both", async () => {
      await connect("c1");
      const claim = await store.claimXeroTokenRefreshLease();
      if (!claim.claimed) throw new Error("expected the lease");
      const save = (tag: string) =>
        store.saveXeroTokens(tokens(tag, 1_800_000), {
          actor: REFRESH_JOB,
          lease: claim.lease,
        });

      const results = await Promise.allSettled([save("a"), save("b")]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = await store.loadXeroTokens();
      const winner = results[0].status === "fulfilled" ? "a" : "b";
      expect(current?.refreshToken).toBe(`race-3806-refresh-${winner}`);
      expect((await release3454.read3454(prisma))?.refreshToken).toBe(`race-3806-refresh-${winner}`);
    });

    it("a disconnect removes every copy, and the retired token key with it", async () => {
      await connect("c1");
      await credentials.withCredentialTransaction(["xero"], (tx) =>
        credentials.setIntegrationCredentialInTransaction({
          tx,
          provider: "xero",
          key: "token_key",
          value: "f".repeat(64),
          actor: ADMIN,
          expect: { expect: "any" },
        }),
      );

      await store.deleteXeroTokens({ actor: ADMIN, cause: { kind: "oauth-disconnect" } });

      expect(await prisma.xeroToken.count()).toBe(0);
      expect(await prisma.xeroConnection.count()).toBe(0);
      expect(
        await prisma.integrationCredential.count({
          where: {
            OR: [
              { provider: store.XERO_OAUTH_TOKEN_PROVIDER },
              { provider: "xero", key: "token_key" },
            ],
          },
        }),
      ).toBe(0);
      expect(await release3454.read3454(prisma)).toBeNull();
    });
  },
);
