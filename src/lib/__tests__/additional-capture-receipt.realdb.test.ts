/**
 * Real-PostgreSQL proof for #3953 (`INV-PAY-138`; owner plan, 21 Oct 2026: "it
 * runs once"): a booking change's card capture that no supplementary invoice
 * waited on gets ONE receipt operation, whoever sees the capture first.
 *
 *  1. The Stripe webhook and the confirm route reporting the same capture at
 *     once, and a replay after both, go through the REAL late-success release
 *     (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent`): one row, one
 *     `receipt-queued`, every other caller `already-released`.
 *  2. Many enqueues at once (`enqueueAdditionalCaptureReceiptOperation`) make
 *     one row.
 *  3. The enqueue runs under the existing per-anchor supplementary-invoice lock
 *     (`lockSupplementaryInvoiceAnchor`) on the change the capture pays for: a
 *     session holding that lock makes the enqueue queue behind it, and the
 *     enqueue then finds the row the holder wrote.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3953-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-3953-owner";
const LODGE_ID = "race-3953-lodge";
const BOOKING_ID = "race-3953-booking";
const PAYMENT_ID = "race-3953-payment";
const PRIMARY_TX_ID = "race-3953-primary-capture";
const CHANGE_TX_ID = "race-3953-change-capture";
/** The change the capture pays for: a provenance stamp, no foreign key. */
const MODIFICATION_ID = "race-3953-modification";
const PRIMARY_INTENT = "pi_race_3953_primary";
const CHANGE_INTENT = "pi_race_3953_change";
const INVOICE_ID = "race-3953-xero-invoice";
const LOCK_POLL_TIMEOUT_MS = 5_000;

let prisma: PrismaClient;
let observerClient: PrismaClient;
let release: typeof import("@/lib/xero-supplementary-invoice-late-capture");
let enqueue: typeof import("@/lib/additional-capture-receipt-enqueue");
let outbox: typeof import("@/lib/xero-operation-outbox");

async function receiptRows() {
  return prisma.xeroSyncOperation.findMany({
    where: { localModel: "PaymentTransaction", localId: CHANGE_TX_ID, queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
    select: { id: true, status: true, correlationKey: true, requestPayload: true },
  });
}

async function clean(): Promise<void> {
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [CHANGE_TX_ID, PRIMARY_TX_ID, PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } },
  });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A confirmed card booking, its primary invoice linked, and a change's captured card ask nothing waited on. */
async function seed(): Promise<void> {
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: new Date("2026-09-10T00:00:00.000Z"),
      checkOut: new Date("2026-09-12T00:00:00.000Z"),
      status: "CONFIRMED",
      totalPriceCents: 38_000,
      finalPriceCents: 38_000,
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: 38_000,
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
}

/** How many sessions are queued behind this backend (`pg_blocking_pids`). */
async function untilQueuedBehind(blockerPid: number): Promise<number> {
  const startedAt = process.hrtime.bigint();
  let queued = 0;
  while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
    const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    queued = rows[0]?.count ?? 0;
    if (queued >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return queued;
}

(RUN ? describe : describe.skip)("a change's card capture is given one Xero receipt, on PostgreSQL (#3953)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Change capture receipt");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    release = await import("@/lib/xero-supplementary-invoice-late-capture");
    enqueue = await import("@/lib/additional-capture-receipt-enqueue");
    outbox = await import("@/lib/xero-operation-outbox");
    const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
      import("@prisma/client"),
      import("@/lib/prisma-adapter"),
    ]);
    const observerUrl = new URL(RACE_DB_URL);
    observerUrl.searchParams.set("connection_limit", "1");
    observerUrl.searchParams.set("application_name", "race-3953-observer");
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
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3953 Lodge", slug: "race-3953" } });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
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

  it("the webhook and the confirm route at once, then a replay, queue one receipt", async () => {
    const [webhook, confirmRoute] = await Promise.all([
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
      release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT),
    ]);
    const replay = await release.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(CHANGE_INTENT);

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: "PENDING",
        correlationKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
        requestPayload: expect.objectContaining({ paymentIntentId: CHANGE_INTENT, paymentTransactionId: CHANGE_TX_ID }),
      }),
    );
    const outcomes = [webhook, confirmRoute, replay].map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["already-released", "already-released", "receipt-queued"]);
    // Exactly one caller is told to kick the outbox for it.
    expect(webhook.released + confirmRoute.released + replay.released).toBe(1);
  });

  it("many enqueues at once make one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => enqueue.enqueueAdditionalCaptureReceiptOperation(CHANGE_INTENT)),
    );

    const rows = await receiptRows();
    expect(rows).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "queued")).toHaveLength(1);
    expect(new Set(results.map((result) => ("queueOperationId" in result ? result.queueOperationId : null)))).toEqual(
      new Set([rows[0]!.id]),
    );
  });

  it("queues behind a session holding the change's supplementary-invoice anchor lock, then finds its row", async () => {
    let holderPid = 0;
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The holder takes the anchor lock and, under it, queues the row itself.
    const holder = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        holderPid = rows[0]?.pid ?? 0;
        await outbox.lockSupplementaryInvoiceAnchor(tx, MODIFICATION_ID);
        locked();
        await held;
        await tx.xeroSyncOperation.create({
          data: {
            direction: "OUTBOUND",
            entityType: "PAYMENT",
            operationType: "CREATE",
            localModel: "PaymentTransaction",
            localId: CHANGE_TX_ID,
            status: "PENDING",
            queueType: "ADDITIONAL_CAPTURE_RECEIPT",
            correlationKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
            idempotencyKey: `payment-intent:${CHANGE_INTENT}:additional-capture-receipt:v1`,
            requestPayload: { queueType: "ADDITIONAL_CAPTURE_RECEIPT" },
          },
        });
      },
      { timeout: 20_000 },
    );
    await lockTaken;

    const waiting = enqueue.enqueueAdditionalCaptureReceiptOperation(CHANGE_INTENT);
    expect(await untilQueuedBehind(holderPid)).toBe(1);
    releaseHolder();
    await holder;

    const result = await waiting;
    expect(result.outcome).toBe("already-queued");
    expect(await receiptRows()).toHaveLength(1);
  });
});
