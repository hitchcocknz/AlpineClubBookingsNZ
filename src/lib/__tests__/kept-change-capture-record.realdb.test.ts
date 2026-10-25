/**
 * Real-PostgreSQL proof for #4324 (owner decision 25 Oct 2026; `INV-PAY-141`,
 * `INV-PAY-139`): a late card payment for a booking change that a treasurer
 * KEPT on a cancelled booking whose primary invoice bills the change is
 * recorded by ONE document, decided once under the approval task's row lock
 * and then the change's supplementary-invoice anchor lock.
 *
 *  1. The keep (the dismissal's status-fenced claim, then its plan on the same
 *     transaction) racing the repair tool's supplementary invoice for the same
 *     change, both queued on a session holding the change's anchor lock: the
 *     capture ends with one recorder, whichever wins.
 *  2. The repair tool's kept-capture action racing a keep of the same task,
 *     both queued on a session holding the task row: one receipt row, which
 *     the loser finds.
 *  3. A webhook replay of the capture after the keep (twice at once) goes
 *     through the REAL late-success release and answers `already-released`;
 *     no second record is queued.
 *  4. An approval after a reopen, committed while the receipt's worker is
 *     between its claim and its locked decision: the worker reads the task
 *     again under the anchor lock and stands down - no payment reaches Xero.
 *
 * The dismissal is driven as `resolveManualRefundTask` drives it - the
 * `OPEN -> DISMISSED` guarded `updateMany`, then `planKeptLateCaptureXeroRecord`
 * on the same transaction - rather than through the whole door, whose other
 * arms (settlement routes, audits) are this proof's noise.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4324-` fixtures.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4324-owner";
const LODGE_ID = "race-4324-lodge";
const BOOKING_ID = "race-4324-booking";
const PAYMENT_ID = "race-4324-payment";
const PRIMARY_TX_ID = "race-4324-primary-capture";
const CHANGE_TX_ID = "race-4324-change-capture";
const MODIFICATION_ID = "race-4324-modification";
const TASK_ID = "race-4324-approval-task";
const PRIMARY_INTENT = "pi_race_4324_primary";
const CHANGE_INTENT = "pi_race_4324_change";
const INVOICE_ID = "race-4324-xero-invoice";
const ZONE = "Pacific/Auckland";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let observerClient: PrismaClient;
let keep: typeof import("@/lib/late-capture-kept-xero");
let release: typeof import("@/lib/xero-supplementary-invoice-late-capture");
let outbox: typeof import("@/lib/xero-operation-outbox");
let kept: typeof import("@/lib/xero-kept-late-capture-invoice");
let recorder: typeof import("@/lib/additional-capture-recorder");
let worker: typeof import("@/lib/additional-capture-xero-receipt");
let claim: typeof import("@/lib/xero-operation-claim");

async function clean(): Promise<void> {
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [CHANGE_TX_ID, PRIMARY_TX_ID, PAYMENT_ID, BOOKING_ID, MODIFICATION_ID, TASK_ID] } },
  });
  await prisma.manualRefundTask.deleteMany({ where: { id: TASK_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * A paid-cancelled card booking: its primary invoice ($380, raised after a $80
 * edit settled against it) linked, $300 paid; the change's $80 card ask
 * captured after the cancel, its approval task open.
 */
async function seed(taskStatus: "OPEN" | "DISMISSED" = "OPEN", options: { marked?: boolean } = {}): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: new Date("2026-09-10T00:00:00.000Z"),
      checkOut: new Date("2026-09-12T00:00:00.000Z"),
      status: "CANCELLED",
      totalPriceCents: 38_000,
      finalPriceCents: 38_000,
    },
  });
  await prisma.bookingModification.create({
    data: {
      id: MODIFICATION_ID,
      bookingId: BOOKING_ID,
      memberId: OWNER_ID,
      modificationType: "GUEST_ADD",
      previousData: {},
      newData: options.marked === false ? {} : { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      priceDiffCents: 8_000,
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: 30_000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: PRIMARY_INTENT,
      xeroInvoiceId: INVOICE_ID,
    },
  });
  await prisma.paymentTransaction.create({
    data: {
      id: PRIMARY_TX_ID,
      paymentId: PAYMENT_ID,
      kind: "PRIMARY",
      source: "STRIPE",
      stripePaymentIntentId: PRIMARY_INTENT,
      amountCents: 30_000,
      status: "SUCCEEDED",
    },
  });
  await prisma.paymentTransaction.create({
    data: {
      id: CHANGE_TX_ID,
      paymentId: PAYMENT_ID,
      kind: "ADDITIONAL",
      source: "STRIPE",
      stripePaymentIntentId: CHANGE_INTENT,
      amountCents: 8_000,
      status: "SUCCEEDED",
      hadIssuedXeroInvoice: false,
      bookingModificationId: MODIFICATION_ID,
    },
  });
  await prisma.manualRefundTask.create({
    data: {
      id: TASK_ID,
      bookingId: BOOKING_ID,
      paymentId: PAYMENT_ID,
      kind: "DELETED_BOOKING_LATE_CAPTURE",
      status: taskStatus,
      lateCaptureApprovalIntentId: CHANGE_INTENT,
      amountCents: 8_000,
      reason: "Late capture held for a treasurer (race proof)",
      ...(taskStatus === "DISMISSED" ? { completedAt: new Date("2026-06-20T00:00:00.000Z"), note: "kept" } : {}),
    },
  });
}

const receiptRows = () =>
  prisma.xeroSyncOperation.findMany({
    where: { localModel: "PaymentTransaction", localId: CHANGE_TX_ID, queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
    select: { id: true, status: true, lastErrorCode: true, requestPayload: true },
  });

const supplementaryRows = () =>
  prisma.xeroSyncOperation.findMany({
    where: { localModel: "BookingModification", localId: MODIFICATION_ID, queueType: "SUPPLEMENTARY_INVOICE" },
    select: { id: true, status: true, requestPayload: true },
  });

/** The keep, as `resolveManualRefundTask` runs it: the status-fenced claim, then the plan, on one transaction. */
function dismiss() {
  return prisma.$transaction(
    async (tx) => {
      const claimed = await tx.manualRefundTask.updateMany({
        where: { id: TASK_ID, status: "OPEN" },
        data: { status: "DISMISSED", completedAt: new Date(), note: "kept (race proof)" },
      });
      if (claimed.count === 0) return { kind: "lost-claim" as const };
      return keep.planKeptLateCaptureXeroRecord({
        manualRefundTaskId: TASK_ID,
        bookingId: BOOKING_ID,
        paymentIntentId: CHANGE_INTENT,
        clubZone: ZONE as never,
        store: tx,
      });
    },
    { timeout: 20_000 },
  );
}

/** The repair tool's kept-capture action: the same decision on a transaction of its own. */
function repairRecord() {
  return prisma.$transaction(
    (tx) =>
      keep.planKeptLateCaptureXeroRecord({
        manualRefundTaskId: TASK_ID,
        bookingId: BOOKING_ID,
        paymentIntentId: CHANGE_INTENT,
        clubZone: ZONE as never,
        store: tx,
      }),
    { timeout: 20_000 },
  );
}

/** How many sessions are queued behind this backend (`pg_blocking_pids`). */
async function untilQueuedBehind(blockerPid: number, target = 1): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let queued = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    queued = rows[0]?.count ?? 0;
    if (queued >= target) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queued;
}

/**
 * How many sessions in this database are waiting on a lock at all. Row locks
 * queue their waiters behind one another (the second waits on the first's
 * tuple lock), so a row-lock barrier counts waiters, not the holder's.
 */
async function untilWaiting(target: number): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let waiting = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0
    `;
    waiting = rows[0]?.count ?? 0;
    if (waiting >= target) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return waiting;
}

/** A session that takes `lock` and holds it until released; resolves its pid once held. */
async function holdLock(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let releaseHolder!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });
  let pid = 0;
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      pid = rows[0]?.pid ?? 0;
      await lock(tx);
      locked();
      await held;
    },
    { timeout: 20_000 },
  );
  await lockTaken;
  return { pid, release: releaseHolder, done: holder };
}

(RUN ? describe : describe.skip)("a kept change capture is recorded once, on PostgreSQL (#4324)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Kept change capture record");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    keep = await import("@/lib/late-capture-kept-xero");
    release = await import("@/lib/xero-supplementary-invoice-late-capture");
    outbox = await import("@/lib/xero-operation-outbox");
    kept = await import("@/lib/xero-kept-late-capture-invoice");
    recorder = await import("@/lib/additional-capture-recorder");
    worker = await import("@/lib/additional-capture-xero-receipt");
    claim = await import("@/lib/xero-operation-claim");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-4324-observer");
    observerClient = new SeparatePrismaClient({ adapter: createPrismaPgAdapter(observerUrl.toString()) });
    await observerClient.$connect();

    await clean();
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: OWNER_ID } });
    await prisma.member.create({
      data: {
        id: OWNER_ID,
        email: `${OWNER_ID}@example.invalid`,
        passwordHash: "not-a-real-password",
        firstName: "Owner",
        lastName: "Proof",
        ageTier: "ADULT",
        canLogin: true,
      },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4324 Lodge", slug: "race-4324" } });
  }, 120_000);

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: OWNER_ID } });
    } finally {
      await observerClient?.$disconnect();
    }
  });

  it("the keep and the repair tool's supplementary invoice for the change, at once: one recorder", { timeout: 30_000 }, async () => {
    // A change that never had a supplementary invoice, which the repair tool now raises.
    await seed("OPEN", { marked: false });
    const holder = await holdLock((tx) => outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID));
    const both = Promise.allSettled([
      dismiss(),
      outbox.enqueueXeroSupplementaryInvoiceOperation({
        bookingId: BOOKING_ID,
        bookingModificationId: MODIFICATION_ID,
        priceDiffCents: 8_000,
        changeFeeCents: 0,
      }),
    ]);
    expect(await untilQueuedBehind(holder.pid, 2)).toBe(2);
    holder.release();
    await holder.done;
    const [keepOutcome, invoiceOutcome] = await both;
    expect(keepOutcome.status).toBe("fulfilled");
    expect(invoiceOutcome.status).toBe("fulfilled");

    const receipts = (await receiptRows()).filter((row) => row.status !== "CANCELLED");
    const invoices = (await supplementaryRows()).filter((row) => row.status !== "CANCELLED");
    expect(invoices).toHaveLength(1);
    // Whichever won, the capture's recorder is one document: the change's own
    // invoice where it records the payment (a queued receipt then stands down
    // at its worker), else the receipt.
    const now = await recorder.readCaptureRecorder({
      bookingId: BOOKING_ID,
      primaryInvoiceId: INVOICE_ID,
      paymentIntentId: CHANGE_INTENT,
      bookingModificationId: MODIFICATION_ID,
    });
    const invoicePays = (invoices[0]!.requestPayload as { recordPayment?: boolean }).recordPayment !== false;
    if (invoicePays) {
      expect(now.kind).toBe("supplementary-invoice");
    } else {
      expect(receipts).toHaveLength(1);
      expect(now.kind).toBe("receipt");
    }
    expect(receipts.length).toBeLessThanOrEqual(1);
  });

  it("the repair tool's action and a re-keep of the same task, at once: one receipt, which the loser finds", { timeout: 30_000 }, async () => {
    await seed("DISMISSED");
    const holder = await holdLock((tx) => kept.lockKeptLateCaptureTask(tx, TASK_ID));
    const both = Promise.all([repairRecord(), repairRecord()]);
    expect(await untilWaiting(2)).toBe(2);
    holder.release();
    await holder.done;
    const outcomes = await both;

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING" });
    expect(outcomes).toEqual([
      { kind: "receipt-queued", queueOperationId: rows[0]!.id },
      { kind: "receipt-queued", queueOperationId: rows[0]!.id },
    ]);
    const keptInvoices = await prisma.xeroSyncOperation.count({
      where: { localModel: "ManualRefundTask", localId: TASK_ID, queueType: "KEPT_LATE_CAPTURE_INVOICE" },
    });
    expect(keptInvoices).toBe(0);
  });

  it("the keep against the repair tool's action on a task still OPEN: one receipt, whichever commits first", { timeout: 30_000 }, async () => {
    await seed("OPEN");
    const holder = await holdLock((tx) => kept.lockKeptLateCaptureTask(tx, TASK_ID));
    const both = Promise.all([dismiss(), repairRecord()]);
    expect(await untilWaiting(2)).toBe(2);
    holder.release();
    await holder.done;
    await both;
    expect(await receiptRows()).toHaveLength(1);
  });

  it("a webhook replay after the keep, twice at once, answers already-released and queues no second record", async () => {
    await seed("OPEN");
    const plan = await dismiss();
    expect(plan).toMatchObject({ kind: "receipt-queued" });
    const replays = await Promise.all([
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
    ]);
    expect(replays.map((result) => result.outcome)).toEqual(["already-released", "already-released"]);
    expect(replays.every((result) => result.released === 0)).toBe(true);
    expect(await receiptRows()).toHaveLength(1);
  });

  it("an approval committed between the receipt worker's claim and its locked decision: the worker stands down, nothing reaches Xero", async () => {
    await seed("OPEN");
    await dismiss();
    const [row] = await receiptRows();
    const claimed = await claim.claimXeroSyncOperationToRunning(row!.id, {
      direction: "OUTBOUND",
      entityType: "PAYMENT",
      operationType: "CREATE",
      localModel: { in: ["PaymentTransaction"] },
    });
    expect(claimed).toBeTruthy();
    // Reopened, then approved: the approval's claim and its settlement, on one transaction.
    await prisma.$transaction(async (tx) => {
      await tx.manualRefundTask.update({ where: { id: TASK_ID }, data: { status: "COMPLETED" } });
      await kept.settleKeptLateCaptureRecordOnApproval({ manualRefundTaskId: TASK_ID, paymentIntentId: CHANGE_INTENT, store: tx });
    });
    // A RUNNING row is not the approval's to withdraw; its worker reads the task again.
    expect((await receiptRows())[0]).toMatchObject({ status: "RUNNING" });

    const paid: unknown[] = [];
    await worker.recordAdditionalCaptureReceipt(
      { syncOperationId: row!.id },
      {
        getAuthenticatedXeroClient: async () =>
          ({
            tenantId: "tenant",
            xero: {
              accountingApi: {
                getInvoice: async () => ({
                  body: { invoices: [{ invoiceID: INVOICE_ID, status: "AUTHORISED", amountDue: 80, payments: [] }] },
                }),
              },
            },
          }) as never,
        callXeroApi: ((call: () => Promise<unknown>) => call()) as never,
        createXeroPaymentForInvoice: async (input) => {
          paid.push(input);
          return "xero_payment_unreachable";
        },
        readStripeCaptureDocumentDate: async () => "2026-06-20",
      },
    );
    expect(paid).toEqual([]);
    expect((await receiptRows())[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("an approval with the receipt still undecided withdraws it", async () => {
    await seed("OPEN");
    await dismiss();
    await prisma.$transaction(async (tx) => {
      await tx.manualRefundTask.update({ where: { id: TASK_ID }, data: { status: "COMPLETED" } });
      await kept.settleKeptLateCaptureRecordOnApproval({ manualRefundTaskId: TASK_ID, paymentIntentId: CHANGE_INTENT, store: tx });
    });
    expect(await receiptRows()).toEqual([
      expect.objectContaining({ status: "CANCELLED", lastErrorCode: "KEPT_LATE_CAPTURE_WITHDRAWN" }),
    ]);
  });
});
