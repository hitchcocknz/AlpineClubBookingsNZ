/**
 * Real-PostgreSQL proof for #4356: two callers that share one ACTIVE Xero
 * operation row never let a failure overwrite a recorded success.
 *
 * When two starts of one Xero operation overlap, the loser's insert hits the
 * one-ACTIVE-row-per-correlation-key index (#1354) and `startXeroSyncOperation`
 * hands it the winner's row. Both callers then make their own Xero call under
 * the same idempotency key and record their own outcome on that one row. The
 * outcome writers used to be unguarded, so whichever wrote last won: a SUCCEEDED
 * row with its Xero payment could be turned FAILED by the other caller's 429 or
 * concurrent-key refusal, and that false failure counted toward the
 * repeated-failure alert. The writers are now guarded (`INV-INT-028`).
 *
 * Driven through a REAL caller, `createXeroPaymentForInvoice`: its start, its
 * completion with the payment's link, and its failure. Xero is a fake at the
 * client seam (`getAuthenticatedXeroClient`, `callXeroApi`), installed with
 * `vi.spyOn` per test and restored after, never a module-level `vi.mock` (this
 * file is imported into the shared race harness). Each fake `createPayments`
 * call waits on its own gate, so a test holds W inside its Xero call, starts L
 * onto W's row, and then decides which call returns first.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4356-` fixtures.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/xero-shared-operation-outcome.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "./helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const RACE_TEST_TIMEOUT_MS = 30_000;

const LOCAL_ID = "race-4356-payment";
const INVOICE_ID = "race-4356-invoice";
// Built, not quoted: a quoted `*Key` literal reads to gitleaks as a secret.
const PAYMENT_KEY = ["race-4356", "invoice-payment", "v1"].join(":");

type Deferred<T = void> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One scripted Xero `createPayments` call: it reports that it started, then waits for its gate. */
type ScriptedCall = { started: Deferred; gate: Deferred; outcome: { paymentId: string } | { error: string } };

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let payments: typeof import("@/lib/xero-invoice-payments");

(RUN ? describe : describe.skip)(
  "#4356: callers sharing one ACTIVE Xero operation row never overwrite a success with a failure - real PostgreSQL",
  { timeout: RACE_TEST_TIMEOUT_MS },
  () => {
    let script: ScriptedCall[] = [];
    let calls = 0;
    const repeatedFailureAlert = vi.fn();

    const createPayments = vi.fn(async () => {
      const call = script[calls];
      calls += 1;
      if (!call) throw new Error("fake Xero: an unscripted createPayments call");
      call.started.resolve();
      await call.gate.promise;
      if ("error" in call.outcome) throw new Error(call.outcome.error);
      return { body: { payments: [{ paymentID: call.outcome.paymentId }] } };
    });

    function scripted(outcome: ScriptedCall["outcome"]): ScriptedCall {
      return { started: deferred(), gate: deferred(), outcome };
    }

    async function clearFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: LOCAL_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: LOCAL_ID } });
    }

    const pay = () =>
      payments.createXeroPaymentForInvoice({
        localModel: "Payment",
        localId: LOCAL_ID,
        invoiceId: INVOICE_ID,
        amountCents: 4_567,
        idempotencyKey: PAYMENT_KEY,
        reference: "race 4356",
        role: "STRIPE_PAYMENT",
        date: "2026-07-01",
      });

    const rows = () =>
      prisma.xeroSyncOperation.findMany({ where: { correlationKey: PAYMENT_KEY }, orderBy: { createdAt: "asc" } });

    /** What the repeated-failure alert counts for this key (`maybeNotifyXeroRepeatedFailure`). */
    const countedFailures = () =>
      prisma.xeroSyncOperation.count({
        where: { correlationKey: PAYMENT_KEY, status: { in: ["FAILED", "PARTIAL"] }, manuallyResolvedAt: null },
      });

    async function waitFor(signal: Promise<void>, what: string) {
      const started = process.hrtime.bigint();
      let done = false;
      void signal.then(() => {
        done = true;
      });
      while (!done) {
        if (realElapsedMs(started) > 10_000) throw new Error(`${what} never happened.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    /**
     * W starts and is held inside its Xero call; L then starts onto W's ACTIVE
     * row and is held inside its own call. Both calls are in flight on ONE row.
     */
    async function startBothOnOneRow(wCall: ScriptedCall, lCall: ScriptedCall) {
      script = [wCall, lCall];
      const w = pay();
      void w.catch(() => undefined);
      await waitFor(wCall.started.promise, "W's Xero call");
      const l = pay();
      void l.catch(() => undefined);
      await waitFor(lCall.started.promise, "L's Xero call");
      const shared = await rows();
      expect(shared).toHaveLength(1);
      expect(shared[0]).toMatchObject({ status: "RUNNING" });
      return { w, l, operationId: shared[0]!.id };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Shared Xero operation outcome (#4356)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      payments = await import("@/lib/xero-invoice-payments");
      await clearFixtures();
    });

    beforeEach(async () => {
      await clearFixtures();
      script = [];
      calls = 0;
      createPayments.mockClear();
      repeatedFailureAlert.mockReset();
      repeatedFailureAlert.mockResolvedValue({ triggered: false, failureCount: 0 });
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({
        xero: { accountingApi: { createPayments } },
        tenantId: "tenant-4356",
      } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      const hardening = await import("@/lib/xero-hardening");
      vi.spyOn(hardening, "maybeNotifyXeroRepeatedFailure").mockImplementation(repeatedFailureAlert as never);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (prisma) await clearFixtures();
    });

    it("W succeeds, then L fails on W's row: the row stays SUCCEEDED with W's payment and no failure is counted", async () => {
      const wCall = scripted({ paymentId: "race-4356-xero-payment-w" });
      const lCall = scripted({ error: "Xero 409: a request with this idempotency key is already being processed" });
      const { w, l, operationId } = await startBothOnOneRow(wCall, lCall);

      wCall.gate.resolve();
      await expect(w).resolves.toBe("race-4356-xero-payment-w");
      lCall.gate.resolve();
      await expect(l).rejects.toThrow("Xero 409");

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "race-4356-xero-payment-w", lastErrorCode: null, lastErrorMessage: null });
      expect(await rows()).toHaveLength(1);
      expect(await countedFailures()).toBe(0);
      expect(repeatedFailureAlert).not.toHaveBeenCalled();
      const link = await prisma.xeroObjectLink.findFirst({ where: { localId: LOCAL_ID, xeroObjectType: "PAYMENT" } });
      expect(link?.xeroObjectId).toBe("race-4356-xero-payment-w");
    });

    it("L succeeds first, then W fails: the same - a failure never lands on the recorded success", async () => {
      const wCall = scripted({ error: "Xero 429: rate limit exceeded" });
      const lCall = scripted({ paymentId: "race-4356-xero-payment-l" });
      const { w, l, operationId } = await startBothOnOneRow(wCall, lCall);

      lCall.gate.resolve();
      await expect(l).resolves.toBe("race-4356-xero-payment-l");
      wCall.gate.resolve();
      await expect(w).rejects.toThrow("Xero 429");

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "race-4356-xero-payment-l", lastErrorCode: null });
      expect(await countedFailures()).toBe(0);
      expect(repeatedFailureAlert).not.toHaveBeenCalled();
    });

    it("W fails, then L succeeds: the success replaces the failure, payment and link recorded (the truer outcome)", async () => {
      const wCall = scripted({ error: "Xero 429: rate limit exceeded" });
      const lCall = scripted({ paymentId: "race-4356-xero-payment-l" });
      const { w, l, operationId } = await startBothOnOneRow(wCall, lCall);

      wCall.gate.resolve();
      await expect(w).rejects.toThrow("Xero 429");
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "FAILED" });
      // W's own failure is a real one when it lands: it is recorded and offered to the alert.
      expect(repeatedFailureAlert).toHaveBeenCalledTimes(1);
      lCall.gate.resolve();
      await expect(l).resolves.toBe("race-4356-xero-payment-l");

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: "race-4356-xero-payment-l", lastErrorCode: null, lastErrorMessage: null });
      expect(await countedFailures()).toBe(0);
      const link = await prisma.xeroObjectLink.findFirst({ where: { localId: LOCAL_ID, xeroObjectType: "PAYMENT" } });
      expect(link?.xeroObjectId).toBe("race-4356-xero-payment-l");
    });
  },
);
