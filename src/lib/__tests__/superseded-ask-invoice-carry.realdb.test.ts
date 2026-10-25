/**
 * Real-PostgreSQL proof for #3403 (owner decision 26 Oct 2026, "follow the
 * money"; `INV-PAY-070`, `INV-PAY-104`): a superseded card change's waiting
 * Xero supplementary invoice moves onto the request that carries its balance.
 *
 * Every state is reached through the real writers: the edit's mint
 * (`createModificationAdditionalPaymentIntent`, which supersedes the earlier
 * ask and moves its invoice before it returns), the edit's Xero leg
 * (`queueXeroBookingEditSettlement`, which parks the change's own invoice on
 * its intent), the supersede's durable cancel (`runPaymentRecoveryOperationNow`),
 * Stripe's success and failure events (`processStripeWebhookEvent`), the
 * booking cancel, the waiting-invoice reaper, a price reduction's retire
 * (`retireUnpaidAskChain`) and the repair pass's enqueue. Only Stripe is a
 * fake, an in-memory intent store in which a capture is something the test
 * does. The booking's primary Xero invoice is a seeded fact; nothing here
 * writes an outbox outcome by hand.
 *
 * Cases:
 *  - A -> B -> B captured: both invoices released, each for its own amount,
 *    and the payments they record sum to the capture;
 *  - B never paid (the booking is cancelled): nothing is invoiced, both retired;
 *  - B captured before A's cancel lands: A's invoice is released at the move;
 *  - a DECLINED A: carried, never cancelled, and still moved at B's mint;
 *  - A -> B -> C: three invoices on C's capture, summing to it;
 *  - the move against a price reduction's retire, both orders, forced on the
 *    anchor's key: the reduction retires and counts A's invoice once;
 *  - the move against the repair pass's enqueue, both orders: one invoice;
 *  - two bank-transfer edits: nothing waits, nothing moves.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`,
 * against a loopback database on port 55442+ named with
 * `concurrency_race_1881`. It owns and cleans its own `race-3403-` fixtures.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/superseded-ask-invoice-carry.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double: pass-through unless a case hooks it.
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3403-member";
const LODGE_ID = "race-3403-lodge";
const BOOKING_ID = "race-3403-booking";
const PAYMENT_ID = "race-3403-payment";
const PRIMARY_INTENT = "pi_race_3403_primary";
const MOD_A = "race-3403-mod-a";
const MOD_B = "race-3403-mod-b";
const MOD_C = "race-3403-mod-c";
const MODS = [MOD_A, MOD_B, MOD_C];
const CHECK_IN = new Date("2027-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const PAID_CENTS = 20_000;
const A_CENTS = 5_000;
const B_CENTS = 3_000;
const C_CENTS = 2_000;

const LOCK_POLL_TIMEOUT_MS = 10_000;

type FakeIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: { message: string } | null;
};

/** Stripe, in memory: intents keep their status, and a cancel or capture moves it. */
const stripe = {
  intents: new Map<string, FakeIntent>(),
  created: [] as string[],
  /** The next cancel throws, as a Stripe outage would: the durable row waits for its retry. */
  failCancels: 0,
};
let webhookEventSequence = 0;

let prisma: PrismaClient;
let holderClient: PrismaClient;
let observerClient: PrismaClient;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

(RUN ? describe : describe.skip)(
  "#3403: a superseded card change's waiting Xero invoice follows the request that carries its balance - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, ...MODS] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID, ...MODS] } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_3403_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_3403_" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { subjectMemberId: MEMBER_ID }] } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID }, select: { id: true } });
      if (payment) await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** A booking paid in full, with its primary Xero invoice issued. */
    async function seedPaidBooking(source: "STRIPE" | "INTERNET_BANKING" = "STRIPE") {
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Follow", lastName: "Money", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3403 Lodge", slug: "race-3403" } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: CHECK_IN,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS,
          source,
          status: "SUCCEEDED",
          xeroInvoiceId: "inv_race_3403_primary",
          ...(source === "STRIPE"
            ? {
                stripePaymentIntentId: PRIMARY_INTENT,
                stripeCustomerId: "cus_race_3403",
                transactions: {
                  create: { kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PAID_CENTS, status: "SUCCEEDED" },
                },
              }
            : {}),
        },
      });
    }

    /**
     * One priced increase of `ownCents`: its history row, the card ask its door
     * mints (carrying whatever the payment still asks for), and its Xero leg,
     * which parks the change's own invoice on that ask - in the door's order.
     */
    async function priceIncrease(modificationId: string, ownCents: number): Promise<string> {
      const [{ createModificationAdditionalPaymentIntent }, { sizeAdditionalAsk }, { queueXeroBookingEditSettlement }] =
        await Promise.all([
          import("@/lib/booking-modification-settlement"),
          import("@/lib/additional-payment-ask"),
          import("@/lib/xero-booking-edit-settlement"),
        ]);
      await prisma.bookingModification.create({
        data: { id: modificationId, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: ownCents },
      });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: { increment: ownCents }, totalPriceCents: { increment: ownCents } } });
      const mirror = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { additionalAmountCents: true, additionalPaymentStatus: true },
      });
      const minted = await createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        door: "guestAdd",
        failureMessage: "race-3403: the mint failed",
        result: {
          pendingRefundAmountCents: 0,
          organiserChildRefund: null,
          paymentId: PAYMENT_ID,
          additionalAsk: sizeAdditionalAsk({ priceDiffCents: ownCents, changeFeeCents: 0, payment: mirror }),
          retiredAdditionalAsks: [],
          hasSucceededPayment: true,
          hasIssuedXeroInvoice: true,
          paymentCustomerId: "cus_race_3403",
          memberEmail: `${MEMBER_ID}@example.invalid`,
          memberName: "Follow Money",
          memberFirstName: "Follow",
          memberId: MEMBER_ID,
          bookingModificationId: modificationId,
          priceLines: null,
        },
      });
      const intentId = minted.additionalPaymentIntentId;
      if (!intentId) throw new Error(`race-3403: ${modificationId}'s ask was not minted`);
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID,
        bookingModificationId: modificationId,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: ownCents,
        changeFeeCents: 0,
        requiresAdditionalStripePayment: true,
        additionalPaymentIntentId: intentId,
      });
      return intentId;
    }

    /** A bank-transfer edit's Xero leg: its invoice is queued unpaid, there is no card ask. */
    async function priceBankTransferIncrease(modificationId: string, ownCents: number) {
      const { queueXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
      await prisma.bookingModification.create({
        data: { id: modificationId, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: ownCents },
      });
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID,
        bookingModificationId: modificationId,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: ownCents,
        changeFeeCents: 0,
        requiresAdditionalStripePayment: false,
        additionalPaymentIntentId: null,
      });
    }

    async function deliver(type: "payment_intent.succeeded" | "payment_intent.payment_failed", intentId: string) {
      const webhook = await import("@/lib/stripe-webhook-service");
      webhookEventSequence += 1;
      const event = {
        id: `evt_race_3403_${webhookEventSequence}`,
        object: "event",
        type,
        request: null,
        data: { object: { ...stripe.intents.get(intentId)! } },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    /** The member pays this request: Stripe captures it, then its success event arrives. */
    async function payWithCard(intentId: string) {
      const intent = stripe.intents.get(intentId)!;
      if (intent.status === "canceled" || intent.status === "succeeded") throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
      intent.status = "succeeded";
      intent.payment_method = "pm_race_3403";
      intent.latest_charge = `ch_${intentId}`;
      await deliver("payment_intent.succeeded", intentId);
    }

    /** The member's card is declined on this request: it stays confirmable with another card. */
    async function declineCard(intentId: string) {
      const intent = stripe.intents.get(intentId)!;
      intent.status = "requires_payment_method";
      intent.last_payment_error = { message: "Your card was declined." };
      await deliver("payment_intent.payment_failed", intentId);
    }

    /** The recovery worker, after its backoff: every open cancel on the booking, run now. */
    async function drainCancels() {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const open = await prisma.paymentRecoveryOperation.findMany({
        where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT", status: { in: ["PENDING", "FAILED"] } },
        select: { id: true },
      });
      for (const row of open) {
        await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { nextRetryAt: new Date(0) } });
        await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
      }
    }

    async function invoices() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: { in: MODS }, queueType: "SUPPLEMENTARY_INVOICE" },
        orderBy: { createdAt: "asc" },
        select: { id: true, localId: true, status: true, lastErrorCode: true, requestPayload: true },
      });
      return rows.map((row) => {
        const payload = row.requestPayload as Record<string, unknown>;
        return {
          id: row.id,
          change: row.localId,
          status: row.status,
          lastErrorCode: row.lastErrorCode,
          waitsOn: payload.paymentIntentId,
          parkedFrom: payload.parkedFromPaymentIntentId,
          cents: (payload.priceDiffCents as number) + (payload.changeFeeCents as number),
          recordPayment: payload.recordPayment,
        };
      });
    }

    async function invoiceFor(change: string) {
      const rows = (await invoices()).filter((row) => row.change === change);
      expect(rows, `one supplementary invoice for ${change}`).toHaveLength(1);
      return rows[0]!;
    }

    async function captured(intentId: string) {
      const row = await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: intentId }, select: { status: true, amountCents: true } });
      expect(row.status).toBe("SUCCEEDED");
      return row.amountCents;
    }

    /** No WAITING invoice anywhere but this suite's, before the global reaper runs. */
    async function assertNoForeignWaitingInvoices() {
      const foreign = await prisma.xeroSyncOperation.findMany({
        where: { status: "WAITING_PAYMENT", NOT: { localId: { in: MODS } } },
        select: { id: true, localId: true },
      });
      expect(foreign, "another suite left WAITING_PAYMENT work the reaper would decide").toEqual([]);
    }

    async function queuedInLine(holderPid: number): Promise<number> {
      const rows = await observerClient.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE line(pid) AS (
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
          UNION
          SELECT activity.pid FROM pg_stat_activity activity
          JOIN line ON line.pid = ANY(pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database()
        )
        SELECT COUNT(*)::int AS "count" FROM line
      `;
      return rows[0]?.count ?? 0;
    }

    async function waitForQueue(holderPid: number, depth: number, what: string) {
      const startedAt = process.hrtime.bigint();
      let seen = 0;
      while (realElapsedMs(startedAt) < LOCK_POLL_TIMEOUT_MS) {
        seen = await queuedInLine(holderPid);
        if (seen >= depth) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${what}: ${seen} session(s) in line behind pid ${holderPid}, expected ${depth}.`);
    }

    /** Hold A's supplementary-invoice anchor key on a third connection until `release` resolves. */
    async function holdAnchor(anchorId: string, release: Promise<void>) {
      const held = deferred();
      let pid = 0;
      let error: unknown;
      const holder = holderClient
        .$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
            pid = rows[0]?.pid ?? 0;
            const { lockSupplementaryInvoiceAnchor } = await import("@/lib/xero-operation-outbox");
            await lockSupplementaryInvoiceAnchor(tx, anchorId);
            held.resolve();
            await release;
          },
          { maxWait: 5_000, timeout: 30_000 },
        )
        .catch((err: unknown) => {
          error = err;
          held.resolve();
        });
      await held.promise;
      if (error) throw new Error(`The holder could not take the anchor key: ${String(error)}`);
      return { pid, holder };
    }

    /** A price reduction's retire of the unpaid chain, in a transaction of its own, as the edit runs it. */
    async function reductionRetiresTheChain() {
      const [{ readUnpaidPriceAsk, retireUnpaidAskChain }, { unpaidAskBillingEvidence }] = await Promise.all([
        import("@/lib/additional-ask-reduction"),
        import("@/lib/unpaid-ask-billing-evidence"),
      ]);
      return prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: {
            id: true,
            status: true,
            payment: { select: { id: true, additionalAmountCents: true, additionalPaymentStatus: true, additionalPaymentIntentId: true } },
          },
        });
        const ask = await readUnpaidPriceAsk(tx, booking);
        const retired = await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
        const evidence = await unpaidAskBillingEvidence(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, rows: ask.rows, retired });
        return { ask, retired, evidence };
      });
    }

    function installStripe() {
      stripeRaceHooks.customer = async () => ({ id: "cus_race_3403", object: "customer", metadata: {} });
      stripeRaceHooks.create = async (args) => {
        const id = `pi_race_3403_${stripe.created.length + 1}`;
        stripe.intents.set(id, {
          id,
          object: "payment_intent",
          amount: args.amountCents,
          currency: "nzd",
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          payment_method: null,
          metadata: args.metadata ?? {},
          latest_charge: null,
          last_payment_error: null,
        });
        stripe.created.push(id);
        return { ...stripe.intents.get(id)! };
      };
      stripeRaceHooks.get = async (id) => {
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        return { ...intent };
      };
      stripeRaceHooks.cancel = async (id) => {
        if (stripe.failCancels > 0) {
          stripe.failCancels -= 1;
          throw new Error("fake Stripe: connection reset");
        }
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
        intent.status = "canceled";
        return { paymentIntent: { ...intent }, canceled: true };
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#3403 superseded-invoice carry");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      const [{ PrismaClient: SeparatePrismaClient }, { createPrismaPgAdapter }] = await Promise.all([
        import("@prisma/client"),
        import("@/lib/prisma-adapter"),
      ]);
      const createSeparateClient = (applicationName: string) => {
        const url = new URL(RACE_DB_URL);
        url.searchParams.set("connection_limit", "1");
        url.searchParams.set("application_name", applicationName);
        return new SeparatePrismaClient({ adapter: createPrismaPgAdapter(url.toString()) });
      };
      holderClient = createSeparateClient("race-3403-holder");
      observerClient = createSeparateClient("race-3403-observer");
      await Promise.all([holderClient.$connect(), observerClient.$connect()]);
    });

    beforeEach(async () => {
      await deleteFixtures();
      stripe.intents.clear();
      stripe.created = [];
      stripe.failCancels = 0;
      installStripe();
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
      await Promise.all([holderClient?.$disconnect(), observerClient?.$disconnect()]);
    });

    it("A -> B -> B captured: both invoices go out, each for its own amount, and their payments sum to the capture", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a, cents: A_CENTS });

      const b = await priceIncrease(MOD_B, B_CENTS);
      // B carries A's $50; A's ask is cancelled and its invoice moved, before B's secret was returned.
      expect(stripe.intents.get(a)?.status).toBe("canceled");
      expect(stripe.intents.get(b)?.amount).toBe(A_CENTS + B_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a, cents: A_CENTS });
      expect(await invoiceFor(MOD_B)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, cents: B_CENTS });

      await payWithCard(b);

      const both = await invoices();
      expect(both.map((row) => [row.change, row.status, row.cents, row.recordPayment])).toEqual([
        [MOD_A, "PENDING", A_CENTS, true],
        [MOD_B, "PENDING", B_CENTS, true],
      ]);
      // Each records its own net as received (`createXeroSupplementaryInvoice`): together, exactly the capture.
      expect(both.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
    });

    it("B never paid: nothing is invoiced, and when the booking is cancelled both invoices are retired", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const b = await priceIncrease(MOD_B, B_CENTS);
      expect((await invoices()).map((row) => [row.status, row.waitsOn])).toEqual([
        ["WAITING_PAYMENT", b],
        ["WAITING_PAYMENT", b],
      ]);
      expect(a).not.toBe(b);

      const { cancelBooking } = await import("@/lib/booking-cancel");
      await cancelBooking(BOOKING_ID, MEMBER_ID, "MEMBER", "127.0.0.1", CLUB_FORMAT_TEST, "credit");
      await drainCancels();
      // The cancel step for B finds no live carrier: nothing moves anywhere.
      expect((await invoices()).every((row) => row.status === "WAITING_PAYMENT" && row.waitsOn === b)).toBe(true);

      await assertNoForeignWaitingInvoices();
      const { reapStaleWaitingPaymentXeroOutboxOperations } = await import("@/lib/xero-waiting-invoice-reaper");
      await reapStaleWaitingPaymentXeroOutboxOperations({ failedTransactionGraceHours: 0 });

      expect((await invoices()).map((row) => [row.change, row.status, row.lastErrorCode])).toEqual([
        [MOD_A, "CANCELLED", "STALE_WAITING_PAYMENT"],
        [MOD_B, "CANCELLED", "STALE_WAITING_PAYMENT"],
      ]);
    });

    it("B captured before A's cancel lands: A's invoice is released at the move", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      // Stripe is down for B's inline cancel of A: A stays open, so nothing moves yet.
      stripe.failCancels = 1;
      const b = await priceIncrease(MOD_B, B_CENTS);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });

      await payWithCard(b);
      expect(await invoiceFor(MOD_B)).toMatchObject({ status: "PENDING", cents: B_CENTS });
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: a });

      // The durable cancel retries: A is cancelled, and its invoice follows the money onto the captured B.
      await drainCancels();

      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "PENDING", waitsOn: b, parkedFrom: a, cents: A_CENTS, recordPayment: true });
      expect((await invoices()).reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(b));
    });

    it("a DECLINED A is carried but never cancelled again: its invoice moves at B's mint all the same", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      await declineCard(a);
      expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: a } })).status).toBe("FAILED");

      const b = await priceIncrease(MOD_B, B_CENTS);
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);
      expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a });

      await payWithCard(b);
      expect((await invoices()).map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    });

    it("A -> B -> C: three invoices on C's capture, each its own, summing to it", async () => {
      await seedPaidBooking();
      const a = await priceIncrease(MOD_A, A_CENTS);
      const b = await priceIncrease(MOD_B, B_CENTS);
      const c = await priceIncrease(MOD_C, C_CENTS);
      expect(stripe.intents.get(c)?.amount).toBe(A_CENTS + B_CENTS + C_CENTS);
      expect((await invoices()).map((row) => [row.change, row.waitsOn, row.parkedFrom ?? null])).toEqual([
        [MOD_A, c, a],
        [MOD_B, c, b],
        [MOD_C, c, null],
      ]);

      await payWithCard(c);

      const all = await invoices();
      expect(all.map((row) => [row.status, row.cents])).toEqual([
        ["PENDING", A_CENTS],
        ["PENDING", B_CENTS],
        ["PENDING", C_CENTS],
      ]);
      expect(all.reduce((sum, row) => sum + row.cents, 0)).toBe(await captured(c));
    });

    describe("the move against a price reduction's retire (`retireUnpaidAskChain`)", () => {
      it("the reduction first, the move queued on A's anchor: A's invoice is retired, counted once, and never moved", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: a });

        const release = deferred();
        const { pid, holder } = await holdAnchor(MOD_A, release.promise);
        // A's durable cancel runs: A FAILED, then the move queues on A's anchor.
        const cancel = drainCancels();
        await waitForQueue(pid, 1, "the move behind the anchor holder");
        const reduction = await reductionRetiresTheChain();
        release.resolve();
        await holder;
        await cancel;

        expect(reduction.retired.invoicedCents).toBe(A_CENTS + B_CENTS);
        expect(reduction.evidence.supplementaryInvoicedCents).toBe(A_CENTS + B_CENTS);
        const after = await invoices();
        expect(after.map((row) => [row.change, row.status, row.waitsOn])).toEqual([
          [MOD_A, "CANCELLED", a],
          [MOD_B, "CANCELLED", b],
        ]);
      });

      it("the move first: the reduction still retires A's invoice off B and reads it as A's own money, once", async () => {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        const b = await priceIncrease(MOD_B, B_CENTS);
        expect(await invoiceFor(MOD_A)).toMatchObject({ waitsOn: b, parkedFrom: a });

        const reduction = await reductionRetiresTheChain();

        expect(reduction.retired.invoicedCents).toBe(A_CENTS + B_CENTS);
        // Attributed to A's row (where it was first asked), not B's: B's own invoice covers B.
        expect(reduction.retired.parkedOps).toEqual(
          expect.arrayContaining([
            { intentId: a, anchorId: MOD_A },
            { intentId: b, anchorId: MOD_B },
          ]),
        );
        expect(reduction.evidence).toEqual({ supplementaryInvoicedCents: A_CENTS + B_CENTS, established: true });
        expect((await invoices()).map((row) => row.status)).toEqual(["CANCELLED", "CANCELLED"]);
      });
    });

    describe("the move against the repair pass's enqueue of A's invoice", () => {
      async function race(first: "repair" | "move") {
        await seedPaidBooking();
        const a = await priceIncrease(MOD_A, A_CENTS);
        stripe.failCancels = 1;
        const b = await priceIncrease(MOD_B, B_CENTS);
        const { enqueueXeroSupplementaryInvoiceOperation } = await import("@/lib/xero-operation-outbox");
        // The repair's QUEUE_SUPPLEMENTARY_INVOICE for an ordinary edit: no plan, the enqueue's defaults.
        const repair = () => enqueueXeroSupplementaryInvoiceOperation({ bookingId: BOOKING_ID, bookingModificationId: MOD_A, priceDiffCents: A_CENTS, changeFeeCents: 0 });

        const release = deferred();
        const { pid, holder } = await holdAnchor(MOD_A, release.promise);
        let repaired: Promise<unknown>;
        let moved: Promise<unknown>;
        if (first === "repair") {
          repaired = repair();
          await waitForQueue(pid, 1, "the repair behind the anchor holder");
          moved = drainCancels();
          await waitForQueue(pid, 2, "the move behind the repair");
        } else {
          moved = drainCancels();
          await waitForQueue(pid, 1, "the move behind the anchor holder");
          repaired = repair();
          await waitForQueue(pid, 2, "the repair behind the move");
        }
        release.resolve();
        await holder;
        await Promise.all([repaired, moved]);
        return { a, b };
      }

      it.each(["repair", "move"] as const)("%s first: one invoice for A's change, waiting on B", async (first) => {
        const { a, b } = await race(first);
        expect(await invoiceFor(MOD_A)).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: b, parkedFrom: a, cents: A_CENTS });
      });
    });

    it("two bank-transfer edits: each invoice was queued unpaid when priced; nothing waits and nothing moves", async () => {
      await seedPaidBooking("INTERNET_BANKING");
      await priceBankTransferIncrease(MOD_A, A_CENTS);
      await priceBankTransferIncrease(MOD_B, B_CENTS);
      const before = await invoices();
      expect(before.map((row) => [row.change, row.status, row.waitsOn, row.recordPayment])).toEqual([
        [MOD_A, "PENDING", null, false],
        [MOD_B, "PENDING", null, false],
      ]);

      const { followSupersededAskInvoicesToCarrier } = await import("@/lib/superseded-ask-invoice-carry");
      expect(await followSupersededAskInvoicesToCarrier({ paymentId: PAYMENT_ID })).toEqual({
        carrierPaymentIntentId: null,
        moved: 0,
        refusals: [],
        releasedOnCapturedCarrier: false,
      });
      expect(await invoices()).toEqual(before);
    });
  },
);
