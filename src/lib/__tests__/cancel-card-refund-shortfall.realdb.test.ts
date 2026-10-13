/**
 * Real-PostgreSQL proof of #4097 (`INV-PAY-129`): an own-card cancel whose
 * frozen card refund plan carries less than the refund due owes the rest by
 * hand.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * `cancelBooking` and `resolveManualRefundTask`:
 *
 * - A partial plan (a $60.00 part of the payment the card cannot refund): the
 *   card refunds $140.00, and the claim's own transaction writes ONE
 *   `CANCELLED_BOOKING_HAND_BACK` for $60.00 under its key - passing every
 *   `ManualRefundTask` CHECK - which "Refunds owed" and Net Collected count. A
 *   re-driven cancel is refused and writes no second one. Marked paid back, it records the
 *   refund on the payment and posts its `BANK_REFUND` line on the card payment,
 *   and stops being owed.
 * - A zero plan (the payment's ledger reads the card refunded, its record does
 *   not): no Stripe call, the whole refund raised as owed. It cannot be marked
 *   paid back against a ledger with nothing left on it, so the treasurer
 *   dismisses it with a note, and it stops being owed.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4097-` fixtures. No Stripe call is made: the cancel's refund goes to the
 * harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4097-member";
const LODGE_ID = "race-4097-lodge";
const BOOKING_ID = "race-4097-booking";
const PAYMENT_ID = "race-4097-payment";
const CARD_TXN = "race-4097-txn-card";
const BANK_TXN = "race-4097-txn-bank";
const INTENT = "pi_race_4097";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const CARD_CENTS = 14_000;
const BANK_CENTS = 6_000;
const TASK_KEY = `cancel-card-shortfall:${BOOKING_ID}`;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Card refund shortfall proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run card refund shortfall proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Card refund shortfall proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Card refund shortfall proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a cancel's card refund shortfall is owed by hand - real PostgreSQL (#4097)",
  { timeout: 60_000 },
  () => {
    async function deleteBookingRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deleteBookingRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /** The payment's owed-back parts, as Net Collected reads them. */
    async function handBackOwedNow(): Promise<number> {
      const { netCollectedPaymentSelect } = await import("@/lib/additional-ledger-gap");
      const { getNetCollectedPaymentParts } = await import("@/lib/payment-net-collected");
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: netCollectedPaymentSelect });
      return getNetCollectedPaymentParts(payment).handBackOwedCents;
    }

    async function refundsOwedNow(): Promise<number> {
      const { readRefundsAndCreditsOwed } = await import("@/lib/refunds-and-credits-owed");
      return (await readRefundsAndCreditsOwed(prisma)).refundsOwedCents;
    }

    async function cancel() {
      const { cancelBooking } = await import("@/lib/booking-cancel");
      return cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    }

    async function resolve(resolution: "completed" | "dismissed", taskId: string, note: string | null = null) {
      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      return resolveManualRefundTask(
        resolution === "completed"
          ? { taskId, resolution, note, actingMemberId: MEMBER_ID, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null }
          : { taskId, resolution, note, actingMemberId: MEMBER_ID, recordedNightPrices: null },
        CLUB_FORMAT_TEST,
      );
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Short",
          lastName: "Plan",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4097 Lodge", slug: "race-4097" } });
      // One tier, all of it back: the cancellation's refund is the whole $200.00.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
    });

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
          stripePaymentIntentId: INTENT,
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("a partial plan: the card refunds what it carries, and the rest is ONE task, owed until it is paid back by bank transfer", async () => {
      // $140.00 by card and a $60.00 part the card cannot refund (taken by bank transfer).
      await prisma.paymentTransaction.createMany({
        data: [
          { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          { id: BANK_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
        ],
      });
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        return {
          id: "re_race_4097",
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: "ch_race_4097",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      const owedBefore = await refundsOwedNow();

      const result = await cancel();

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { refundAmountCents: PRICE_CENTS, ownCardRefund: { method: "card", amountCents: CARD_CENTS, byHandCents: BANK_CENTS } } });
      expect(asked).toEqual([CARD_CENTS]);
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        status: "OPEN",
        occurrenceKey: TASK_KEY,
        paymentId: PAYMENT_ID,
        amountCents: BANK_CENTS,
        raisedAmountCents: BANK_CENTS,
      });
      expect(await handBackOwedNow()).toBe(BANK_CENTS);
      expect((await refundsOwedNow()) - owedBefore).toBe(BANK_CENTS);

      // A re-driven cancel is refused (the booking is cancelled) and writes nothing.
      expect((await cancel()).status).not.toBe(200);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

      // Paid back by bank transfer: on the payment, on the ledger, and owed nowhere.
      await resolve("completed", tasks[0]!.id);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: tasks[0]!.id }, select: { status: true } })).toEqual({ status: "COMPLETED" });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: PRICE_CENTS });
      const handBackLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, postingKey: `handback:${tasks[0]!.id}` },
        select: { kind: true, amountCents: true, settlementMethod: true },
      });
      expect(handBackLines).toEqual([{ kind: "BANK_REFUND", amountCents: -BANK_CENTS, settlementMethod: "INTERNET_BANKING" }]);
      expect(await handBackOwedNow()).toBe(0);
      expect(await refundsOwedNow()).toBe(owedBefore);
    });

    it("a zero plan: no card refund, the whole refund owed; with nothing left on the ledger it is dismissed with a note, and owed no more", async () => {
      // The ledger reads the charge refunded; the payment record does not.
      await prisma.paymentTransaction.create({
        data: { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: PRICE_CENTS, refundedAmountCents: PRICE_CENTS, status: "REFUNDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      let asked = 0;
      stripeRaceHooks.refund = async () => {
        asked += 1;
        throw new Error("no card refund may be asked for on a zero plan");
      };
      const owedBefore = await refundsOwedNow();

      const result = await cancel();

      expect(result.status).toBe(200);
      expect(result).toMatchObject({ data: { ownCardRefund: { method: "card", amountCents: 0, byHandCents: PRICE_CENTS } } });
      expect(asked).toBe(0);
      const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: TASK_KEY } });
      expect(task).toMatchObject({ status: "OPEN", amountCents: PRICE_CENTS });
      expect((await refundsOwedNow()) - owedBefore).toBe(PRICE_CENTS);

      // Nothing on the ledger to record it against: refused, still OPEN.
      await expect(resolve("completed", task.id)).rejects.toMatchObject({ status: 400 });
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "OPEN" });

      await resolve("dismissed", task.id, "Refunded in the Stripe dashboard on 2 July.");
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "DISMISSED" });
      expect(await refundsOwedNow()).toBe(owedBefore);
    });
  },
);
