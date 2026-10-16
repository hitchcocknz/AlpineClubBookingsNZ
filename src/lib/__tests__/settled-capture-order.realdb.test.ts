/**
 * Real-PostgreSQL proof of #4177 (`INV-PAY-133`): when a different card
 * capture arrives on an already-PAID booking and several captures could be the
 * one that settled it, the duplicate-capture refund names the OLDEST-INSERTED
 * (`createdAt`, then `insertionSeq`), the rule #4163 set for the Xero settling
 * capture, whatever order PostgreSQL keeps the rows in.
 *
 * What a mock can only imitate, run here through the REAL
 * `markBookingPaymentSucceeded`:
 *
 * - Two settled captures, the first inserted before the second. CLUSTER on the
 *   primary key, whose ids are named so the LATER capture sorts first, puts the
 *   later one first in the heap, verified through `ctid`. With the two tied on
 *   `createdAt`, the same read with no order meets the later one first: the
 *   premise an unordered read gets wrong.
 * - The arriving third capture is refunded alone, and the admin-only history
 *   event the refund records names the FIRST capture as the settlement: with
 *   distinct `createdAt`, and with both captures tied on one `createdAt`, where
 *   only `insertionSeq` tells them apart.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`settled-capture-order-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4177-` fixtures. No Stripe call is made: the refund goes
 * to the harness's one shared `@/lib/stripe` double.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4177-member";
const LODGE_ID = "race-4177-lodge";
const BOOKING_ID = "race-4177-booking";
const PAYMENT_ID = "race-4177-payment";
// Named so `id` order puts the LATER capture first: CLUSTER on the primary key
// then makes the heap disagree with insertion order.
const FIRST = "race-4177-txn-z";
const LATER = "race-4177-txn-x";
const ARRIVING = "race-4177-txn-y";
const FIRST_PI = "pi_race_4177_first";
const LATER_PI = "pi_race_4177_later";
const ARRIVING_PI = "pi_race_4177_arriving";
const PRICE_CENTS = 20_000;
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const EARLIER = new Date("2026-06-14T00:00:00.000Z");
const TIED_AT = new Date("2026-06-15T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Settled-capture order proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run settled-capture order proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Settled-capture order proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Settled-capture order proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the duplicate-capture refund names the first-inserted settled capture, not heap order - real PostgreSQL (#4177)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * Insert the first settled capture, then the later one (with the given
     * `createdAt`s), then the arriving capture still PROCESSING; then establish
     * a heap order with the later capture ahead of the first.
     */
    async function writeCapturesLaterFirstInHeap(createdAt: { first: Date; later: Date }) {
      const capture = (id: string, paymentIntentId: string, at: Date, status: "SUCCEEDED" | "PROCESSING") => ({
        id,
        paymentId: PAYMENT_ID,
        kind: "PRIMARY" as const,
        source: "STRIPE" as const,
        stripePaymentIntentId: paymentIntentId,
        amountCents: PRICE_CENTS,
        status,
        createdAt: at,
      });
      await prisma.$transaction(async (tx) => {
        await tx.paymentTransaction.create({ data: capture(FIRST, FIRST_PI, createdAt.first, "SUCCEEDED") });
        await tx.paymentTransaction.create({ data: capture(LATER, LATER_PI, createdAt.later, "SUCCEEDED") });
      });
      await prisma.paymentTransaction.create({
        data: capture(ARRIVING, ARRIVING_PI, new Date("2026-06-20T00:00:00.000Z"), "PROCESSING"),
      });
      // Whole-table rewrite, only in the already guarded disposable database,
      // on the existing primary-key index; row values and sequences stay intact.
      await prisma.$executeRaw`CLUSTER "PaymentTransaction" USING "PaymentTransaction_pkey"`;

      const heap = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "PaymentTransaction" WHERE "paymentId" = ${PAYMENT_ID} ORDER BY ctid`;
      expect(heap.map((row) => row.id), "premise: CLUSTER put the later capture first in the heap").toEqual([
        LATER,
        ARRIVING,
        FIRST,
      ]);
      const seq = Object.fromEntries(
        (
          await prisma.paymentTransaction.findMany({
            where: { paymentId: PAYMENT_ID },
            select: { id: true, insertionSeq: true },
          })
        ).map((row) => [row.id, row.insertionSeq]),
      );
      expect(seq[FIRST]! < seq[LATER]!, "premise: the first capture was inserted first").toBe(true);
      if (createdAt.first.getTime() !== createdAt.later.getTime()) return;
      // On a tie every plan returns heap order (a btree keeps equal keys in heap
      // order), so the guard's own filter with no order meets the later capture
      // first: the answer the unordered read gave. Apart, an index on
      // `createdAt` may return the first, so the premise is asserted only here.
      const unordered = await prisma.paymentTransaction.findFirst({
        where: {
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] },
          source: "STRIPE",
          stripePaymentIntentId: { not: ARRIVING_PI },
        },
        select: { id: true },
      });
      expect(unordered?.id, "premise: an unordered read meets the later capture first").toBe(LATER);
    }

    /** Stripe makes the refund it is asked for, recording the intents asked. */
    function stripeMakesRefunds(): string[] {
      const asked: string[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.paymentIntentId);
        return {
          id: `re_race_4177_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4177",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    async function settleArrivingCapture() {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      return markBookingPaymentSucceeded({
        bookingId: BOOKING_ID,
        paymentIntentId: ARRIVING_PI,
        amountCents: PRICE_CENTS,
        paymentMethodId: null,
        format: CLUB_FORMAT_TEST,
      });
    }

    async function settledIntentTheHistoryNames(): Promise<unknown> {
      const events = await prisma.bookingEvent.findMany({
        where: { bookingId: BOOKING_ID, type: "REFUNDED" },
        select: { snapshot: true },
      });
      expect(events).toHaveLength(1);
      const snapshot = events[0]!.snapshot as { duplicatePaymentIntentId?: string; settledPaymentIntentId?: string | null };
      expect(snapshot.duplicatePaymentIntentId).toBe(ARRIVING_PI);
      return snapshot.settledPaymentIntentId;
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Settled",
          lastName: "Capture",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4177 Lodge", slug: "race-4177" } });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "PAID",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          stripePaymentIntentId: FIRST_PI,
        },
      });
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("captures created apart, the later one first in the heap: the refund names the first as the settlement", async () => {
      await writeCapturesLaterFirstInHeap({ first: EARLIER, later: TIED_AT });
      const asked = stripeMakesRefunds();

      const result = await settleArrivingCapture();

      expect(result.outcome).toBe("duplicate_capture_refunded");
      expect(asked, "only the arriving capture is refunded").toEqual([ARRIVING_PI]);
      expect(await settledIntentTheHistoryNames()).toBe(FIRST_PI);
    });

    it("captures tied on createdAt, the later one first in the heap: insertionSeq decides, and the refund names the first", async () => {
      await writeCapturesLaterFirstInHeap({ first: TIED_AT, later: TIED_AT });
      const asked = stripeMakesRefunds();

      const result = await settleArrivingCapture();

      expect(result.outcome).toBe("duplicate_capture_refunded");
      expect(asked, "only the arriving capture is refunded").toEqual([ARRIVING_PI]);
      expect(await settledIntentTheHistoryNames()).toBe(FIRST_PI);
    });
  },
);
