/**
 * Real-PostgreSQL proof of #4083 (`INV-PAY-125`): a card refund Stripe answered
 * `failed` or `canceled` is still owed, and its retry asks under a fresh key.
 *
 * Three things a mock can only imitate, run here against the database:
 *
 * - The edit door's enqueue is one row per booking edit: replaying it (a retry
 *   of the after-commit step) writes no second row, and the refused slices it
 *   froze read back exactly, as the runner will replay them.
 * - The runner moves a refused slice to its next key ONLY on the attempt it
 *   holds: the write is fenced on PROCESSING and the claim's own
 *   `processingStartedAt`, so an attempt the stale reaper has since handed back
 *   (or one that already closed) moves nothing, and the generation never skips.
 * - "Refunds owed" (`openCardRefundOwedCents`, read through
 *   `netCollectedCardRefundSelect`) counts the queued row at what Stripe
 *   refused, keeps counting it through a second refusal, and stops once a
 *   refund of that slice is made after the row was raised.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4083-` fixtures. No Stripe call is made: the refund's answer is handed
 * to the runner's seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4083-member";
const LODGE_ID = "race-4083-lodge";
const BOOKING_ID = "race-4083-booking";
const PAYMENT_ID = "race-4083-payment";
const PRIMARY_TXN = "race-4083-txn-primary";
const ADDITIONAL_TXN = "race-4083-txn-additional";
const MODIFICATION_ID = "race-4083-mod";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const EDITED_AT = new Date("2026-06-20T00:00:00.000Z");
const RETRIED_AT = new Date("2026-06-20T00:10:00.000Z");

const PRIMARY_CENTS = 14_000;
const ADDITIONAL_CENTS = 6_000;
// A $100.00 edit refund: $60.00 made from the newer charge, $40.00 refused on the older one.
const MADE_CENTS = 6_000;
const REFUSED_CENTS = 4_000;

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refused-refund proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refused-refund proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Refused-refund proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Refused-refund proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let enqueueBookingModificationRefundRecovery: (typeof import("@/lib/payment-recovery"))["enqueueBookingModificationRefundRecovery"];
let refundPlanOrRetryRefusals: (typeof import("@/lib/refused-card-refund-retry"))["refundPlanOrRetryRefusals"];
let parseRefundAllocationPlan: (typeof import("@/lib/open-card-refund-owed"))["parseRefundAllocationPlan"];
let openCardRefundOwedCents: (typeof import("@/lib/open-card-refund-owed"))["openCardRefundOwedCents"];
let netCollectedCardRefundSelect: (typeof import("@/lib/additional-ledger-gap"))["netCollectedCardRefundSelect"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

const REFUSED_SLICE = { paymentTransactionId: PRIMARY_TXN, amountCents: REFUSED_CENTS };

(RUN ? describe : describe.skip)(
  "a card refund Stripe refused stays owed and is retried under a fresh key — real PostgreSQL (#4083)",
  { timeout: 20_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.paymentRecoveryOperation.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function recordRefund(id: string, transactionId: string, amountCents: number, status: string, at: Date) {
      await prisma.paymentRefund.create({
        data: {
          paymentId: PAYMENT_ID,
          paymentTransactionId: transactionId,
          stripeRefundId: id,
          amountCents,
          currency: "nzd",
          status,
          stripeCreatedAt: at,
          createdAt: at,
        },
      });
    }

    async function owedNow(): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** The edit door's enqueue, exactly as `executeBookingModificationRefund` sends it. */
    async function queueRefusedSlice() {
      return enqueueBookingModificationRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        bookingModificationId: MODIFICATION_ID,
        amountCents: REFUSED_CENTS,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
        allocationPlan: [REFUSED_SLICE],
      });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ enqueueBookingModificationRefundRecovery } = await import("@/lib/payment-recovery"));
      ({ refundPlanOrRetryRefusals } = await import("@/lib/refused-card-refund-retry"));
      ({ parseRefundAllocationPlan, openCardRefundOwedCents } = await import("@/lib/open-card-refund-owed"));
      ({ netCollectedCardRefundSelect } = await import("@/lib/additional-ledger-gap"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Refused",
          lastName: "Refund",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4083 Lodge", slug: "race-4083" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CONFIRMED",
          totalPriceCents: PRIMARY_CENTS + ADDITIONAL_CENTS - MADE_CENTS - REFUSED_CENTS,
          finalPriceCents: PRIMARY_CENTS + ADDITIONAL_CENTS - MADE_CENTS - REFUSED_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRIMARY_CENTS + ADDITIONAL_CENTS,
          // Only the made slice counts; the refused one sent nothing back.
          refundedAmountCents: MADE_CENTS,
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: PRIMARY_TXN,
          paymentId: PAYMENT_ID,
          kind: "PRIMARY",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_4083_primary",
          amountCents: PRIMARY_CENTS,
          status: "SUCCEEDED",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: ADDITIONAL_TXN,
          paymentId: PAYMENT_ID,
          kind: "ADDITIONAL",
          source: "STRIPE",
          stripePaymentIntentId: "pi_race_4083_additional",
          amountCents: ADDITIONAL_CENTS,
          refundedAmountCents: MADE_CENTS,
          status: "REFUNDED",
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      // The edit's refund as `refundPaymentTransactions` recorded it: one made, one refused.
      await recordRefund("re_race_4083_made", ADDITIONAL_TXN, MADE_CENTS, "succeeded", EDITED_AT);
      await recordRefund("re_race_4083_refused", PRIMARY_TXN, REFUSED_CENTS, "failed", EDITED_AT);
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    });

    it("the edit's refused slice is queued once: a replayed enqueue writes no second row, and the plan reads back exactly", async () => {
      expect(await owedNow()).toBe(0);

      await queueRefusedSlice();
      await queueRefusedSlice();

      const rows = await prisma.paymentRecoveryOperation.findMany({ where: { paymentId: PAYMENT_ID } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "REFUND_BOOKING_MODIFICATION",
        status: "PENDING",
        amountCents: REFUSED_CENTS,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
      });
      expect(parseRefundAllocationPlan(rows[0]?.allocationPlan)).toEqual([REFUSED_SLICE]);
    });

    it("Refunds owed counts what Stripe refused, through a second refusal, until a retry makes it", async () => {
      const queued = await queueRefusedSlice();
      // Raised after the edit's refunds were recorded, as the door raises it.
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { createdAt: new Date("2026-06-20T00:00:01.000Z") } });
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The runner's retry under `refused1` is refused again: not progress.
      await recordRefund("re_race_4083_refused_again", PRIMARY_TXN, REFUSED_CENTS, "canceled", RETRIED_AT);
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The next retry is made: the slice is filled, nothing is owed.
      await recordRefund("re_race_4083_retried", PRIMARY_TXN, REFUSED_CENTS, "succeeded", new Date("2026-06-20T00:20:00.000Z"));
      expect(await owedNow()).toBe(0);
    });

    it("the runner moves a refused slice only on the attempt it holds, and never skips a generation", async () => {
      const queued = await queueRefusedSlice();
      const claimedAt = new Date("2026-06-20T00:05:00.000Z");
      await prisma.paymentRecoveryOperation.update({
        where: { id: queued.id },
        data: { status: "PROCESSING", attempts: 1, processingStartedAt: claimedAt },
      });
      const refusedAnswer = (slice: { paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string }) => async () => ({
        refunds: [{ status: "failed", slice }],
      });
      const planNow = async () =>
        parseRefundAllocationPlan(
          (await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: queued.id } })).allocationPlan,
        );

      // The attempt this worker holds: the slice moves to `refused1`, and the attempt fails.
      await expect(
        refundPlanOrRetryRefusals({
          operation: { id: queued.id, processingStartedAt: claimedAt },
          plan: [REFUSED_SLICE],
          format: CLUB_FORMAT_TEST,
          refund: refusedAnswer(REFUSED_SLICE),
        }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([{ ...REFUSED_SLICE, stripeKeySuffix: "refused1" }]);

      // A stale attempt (the reaper handed the row back and it was claimed again)
      // reads `refused1` refused too, but its fence misses: nothing moves.
      const reclaimedAt = new Date("2026-06-20T00:30:00.000Z");
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { processingStartedAt: reclaimedAt } });
      const moved = { ...REFUSED_SLICE, stripeKeySuffix: "refused1" };
      await expect(
        refundPlanOrRetryRefusals({
          operation: { id: queued.id, processingStartedAt: claimedAt },
          plan: [moved],
          format: CLUB_FORMAT_TEST,
          refund: refusedAnswer(moved),
        }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([moved]);

      // A closed row is never written, whoever reads a refusal.
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { status: "SUCCEEDED", succeededAt: RETRIED_AT } });
      await expect(
        refundPlanOrRetryRefusals({
          operation: { id: queued.id, processingStartedAt: reclaimedAt },
          plan: [moved],
          format: CLUB_FORMAT_TEST,
          refund: refusedAnswer(moved),
        }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([moved]);
    });
  },
);
