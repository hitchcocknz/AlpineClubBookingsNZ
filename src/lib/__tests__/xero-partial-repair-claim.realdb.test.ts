/**
 * Real-PostgreSQL proof that a PARTIAL invoice repair claims its row before it
 * writes or calls Xero (#4256).
 *
 * Xero Operations Retry on a PARTIAL invoice create records the payment the
 * create could not. It used to do that without claiming the row, so an
 * officer's resolve or mark non-replayable landing after its read was
 * overwritten (the zero-cash path completed the row SUCCEEDED with no guard),
 * and two retries of one row both reached Xero. The repair now runs inside the
 * PARTIAL-only claim (`runWithClaimedOriginal`), a status-guarded `UPDATE`.
 * A double can only imitate that guard; this file runs it against the migrated
 * schema, with the officer's write landing WHILE the retry waits on its claim:
 *
 *   - a resolve, or a mark non-replayable, committed between the retry's read
 *     and its claim makes the claim lose: no Xero call, the row untouched;
 *   - two retries of one row at once make one payment write;
 *   - a failed payment write gives the row back PARTIAL with its payload, and
 *     the next retry repairs it.
 *
 * Xero itself is faked (no provider call). Ordinary Vitest runs skip the whole
 * file. It reuses the guarded, disposable loopback PostgreSQL
 * `concurrency-lock-races.realdb.test.ts` provisions (#1881), which imports
 * this file so CI reaches it; it owns and cleans its own `race-4256-` fixtures.
 *
 * To run directly against a throwaway scratch database:
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-partial-repair-claim.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { realElapsedMs } from "./helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const PAYMENT_ID = "race-4256-payment";
const OPERATION_ID = "race-4256-op-partial";
const INVOICE_ID = "race-4256-invoice";
const PAYMENT_KEY = `payment:${PAYMENT_ID}:invoice-payment:v1`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafePartialRepairClaimRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("PARTIAL repair claim proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run PARTIAL repair claim proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("PARTIAL repair claim proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("PARTIAL repair claim proof DB name must contain 'concurrency_race_1881'.");
  }
}

describe("PARTIAL repair claim race DB safety guard (#4256)", () => {
  it("accepts only a dedicated loopback scratch database", () => {
    expect(() =>
      assertSafePartialRepairClaimRaceDbUrl("postgresql://u:p@127.0.0.1:55442/concurrency_race_1881"),
    ).not.toThrow();
  });

  it.each([
    "postgresql://u:p@db.example.org:55442/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881",
    "postgresql://u:p@127.0.0.1:55442/app",
    "not-a-url",
  ])("rejects unsafe target %s", (url) => {
    expect(() => assertSafePartialRepairClaimRaceDbUrl(url)).toThrow();
  });
});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let retry: typeof import("@/lib/xero-operation-retry");

(RUN ? describe : describe.skip)(
  "a PARTIAL invoice repair claims its row first - real PostgreSQL (#4256)",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    const createPayments = vi.fn();

    async function clearFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
    }

    /** A primary booking invoice whose create raised the invoice and failed its payment write. */
    const partialPayload = (totalDollars: number) => ({
      invoice: { invoices: [{ invoiceID: INVOICE_ID, total: totalDollars }] },
      payment: null,
      paymentError: { message: "Xero 503 on the payment write" },
      paymentSkipped: false,
    });

    async function seedPartial(totalDollars: number) {
      await prisma.xeroSyncOperation.create({
        data: {
          id: OPERATION_ID,
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: PAYMENT_ID,
          status: "PARTIAL",
          idempotencyKey: "race-4256-invoice-key",
          correlationKey: "race-4256-invoice-key",
          responsePayload: partialPayload(totalDollars),
          xeroObjectType: "INVOICE",
          xeroObjectId: INVOICE_ID,
          xeroObjectNumber: "INV-4256",
          completedAt: new Date(),
        },
      });
    }

    const readRow = () => prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: OPERATION_ID } });
    const paymentRows = () =>
      prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, entityType: "PAYMENT" } });

    /**
     * Hold the row's lock while the retry reads it, wait until its claim is
     * blocked on that lock, then commit `officerWrite` - the officer's mark
     * landing between the retry's read and its claim.
     */
    async function landWhileClaimWaits<T>(
      officerWrite: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
      runRetry: () => Promise<T>,
    ): Promise<PromiseSettledResult<T>> {
      let retried!: Promise<PromiseSettledResult<T>>;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "XeroSyncOperation" WHERE id = ${OPERATION_ID} FOR UPDATE`;
          retried = runRetry().then(
            (value) => ({ status: "fulfilled", value }) as const,
            (reason: unknown) => ({ status: "rejected", reason }) as const,
          );
          const started = process.hrtime.bigint();
          for (;;) {
            const waiting = await prisma.$queryRaw<Array<{ n: bigint }>>`
              SELECT count(*)::bigint AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query ILIKE '%UPDATE%XeroSyncOperation%'`;
            if (Number(waiting[0]?.n ?? 0) > 0) break;
            if (realElapsedMs(started) > 10_000) throw new Error("The retry never reached its claim.");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await officerWrite(tx);
        },
        { timeout: 20_000 },
      );
      return retried;
    }

    beforeAll(async () => {
      assertSafePartialRepairClaimRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      retry = await import("@/lib/xero-operation-retry");
      await clearFixtures();
    });

    beforeEach(async () => {
      await clearFixtures();
      createPayments.mockReset();
      createPayments.mockImplementation(async () => ({
        body: { payments: [{ paymentID: `race-4256-xero-payment-${createPayments.mock.calls.length}` }] },
      }));
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({
        xero: { accountingApi: { createPayments } },
        tenantId: "tenant-4256",
      } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (prisma) await clearFixtures();
    });

    it.each([
      ["the payment repair", 45.67],
      ["the zero-cash repair", 0],
    ])("a resolve committed while %s waits on its claim wins: no Xero call, the row left resolved and PARTIAL", async (_label, total) => {
      await seedPartial(total);
      const resolvedAt = new Date("2026-06-30T00:00:00.000Z");

      const outcome = await landWhileClaimWaits(
        (tx) => tx.xeroSyncOperation.update({ where: { id: OPERATION_ID }, data: { manuallyResolvedAt: resolvedAt } }),
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      );

      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(retry.XeroOperationResolvedInXeroError);
      expect(createPayments).not.toHaveBeenCalled();
      expect(await paymentRows()).toBe(0);
      const row = await readRow();
      expect(row).toMatchObject({ status: "PARTIAL", manuallyResolvedAt: resolvedAt });
      expect(row.responsePayload).toEqual(partialPayload(total));
    });

    it("a mark non-replayable committed while the repair waits on its claim wins too", async () => {
      await seedPartial(45.67);

      const outcome = await landWhileClaimWaits(
        (tx) => tx.xeroSyncOperation.update({ where: { id: OPERATION_ID }, data: { replayable: false } }),
        () => retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      );

      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
        message: "This operation is not marked replayable.",
      });
      expect(createPayments).not.toHaveBeenCalled();
      expect(await readRow()).toMatchObject({ status: "PARTIAL", replayable: false });
    });

    it("two retries of one row at once make one payment write and close the row once", async () => {
      await seedPartial(45.67);

      const outcomes = await Promise.allSettled([
        retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
        retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ status: 409 });
      expect(createPayments).toHaveBeenCalledTimes(1);
      expect(createPayments.mock.calls[0][3]).toBe(PAYMENT_KEY);
      expect(await paymentRows()).toBe(1);
      const row = await readRow();
      expect(row.status).toBe("SUCCEEDED");
      expect(row.xeroObjectNumber).toBe("INV-4256");
      expect(row.responsePayload).toMatchObject({ paymentError: null, payment: { paymentID: expect.any(String) } });
    });

    it("a failed payment write gives the row back PARTIAL with its payload, and the next retry repairs it", async () => {
      await seedPartial(45.67);
      createPayments.mockRejectedValueOnce(new Error("Xero 503 again"));

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).rejects.toThrow("Xero 503 again");
      const givenBack = await readRow();
      expect(givenBack).toMatchObject({ status: "PARTIAL", lastErrorMessage: "Xero 503 again" });
      expect(givenBack.responsePayload).toEqual(partialPayload(45.67));
      expect(retry.getXeroOperationRetryMeta(givenBack)).toEqual({ supported: true, reason: null });

      await expect(retry.retryXeroSyncOperation(OPERATION_ID, CLUB_FORMAT_TEST)).resolves.toEqual({
        message: "Repaired Xero booking invoice payment recording.",
      });
      expect((await readRow()).status).toBe("SUCCEEDED");
    });
  },
);
