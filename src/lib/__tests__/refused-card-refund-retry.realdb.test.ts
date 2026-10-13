/**
 * Real-PostgreSQL proof of #4083 and #4096 (`INV-PAY-127`): a card refund Stripe
 * answered `failed` or `canceled` on a booking edit or a cancellation is still
 * owed, and its retry asks under a fresh key.
 *
 * What a mock can only imitate, run here against the database:
 *
 * - The edit door's enqueue is one row per booking edit: a second enqueue (a
 *   retry of the after-commit step) writes no second row, and never re-plans a
 *   row a worker has picked up - its plan, amount and prefix stand.
 * - The runner moves a refused slice to its next key ONLY on the attempt it
 *   holds: the write is fenced on PROCESSING and the claim's own
 *   `processingStartedAt`, so an attempt the stale reaper has since handed back
 *   (or one that already closed) moves nothing, and the generation never skips.
 * - "Refunds owed" (`openCardRefundOwedCents`, read through
 *   `netCollectedCardRefundSelect`) counts the queued row at what Stripe
 *   refused, keeps counting it through a second refusal, and stops once a
 *   refund of that slice is made after the row was raised.
 * - The REAL `cancelBooking`, with a Stripe double answering the refund
 *   `failed`: the booking is cancelled, its pre-persisted refund row stays
 *   PENDING, re-planned to the refused slice on its next key, and "Refunds owed"
 *   counts it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4083-` fixtures. No Stripe call is made: the runner's refund is handed
 * to its seam, and the cancel's to the harness's one shared `@/lib/stripe`
 * double (`support/stripe-race-double.ts`), a pass-through unless hooked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

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
/** Read refused at the door, so queued already on its next key. */
const QUEUED_SLICE = { ...REFUSED_SLICE, stripeKeySuffix: "refused1" };
const OPERATION_KEY = `payment_recovery_modification_refund_${MODIFICATION_ID}`;

// #4096: a second booking, cancelled for real.
const CANCEL_BOOKING_ID = "race-4083-cancel-booking";
const CANCEL_PAYMENT_ID = "race-4083-cancel-payment";
const CANCEL_TXN = "race-4083-cancel-txn";
const CANCEL_INTENT = "pi_race_4083_cancel";
const CANCEL_CENTS = 20_000;
const CANCEL_ADDITIONAL_TXN = "race-4083-cancel-txn-additional";
const CANCEL_ADDITIONAL_INTENT = "pi_race_4083_cancel_additional";

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

    async function deleteCancelRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: CANCEL_BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [CANCEL_PAYMENT_ID, CANCEL_BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: CANCEL_PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: CANCEL_PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: CANCEL_PAYMENT_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: CANCEL_BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: CANCEL_BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await deleteCancelRows();
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
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

    async function owedNow(paymentId = PAYMENT_ID): Promise<number> {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: { status: true, amountCents: true, refundedAmountCents: true, ...netCollectedCardRefundSelect },
      });
      return openCardRefundOwedCents(payment);
    }

    /** The edit door's enqueue, exactly as `executeBookingModificationRefund` sends it. */
    async function queueRefusedSlice(
      plan: Array<{ paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string }> = [QUEUED_SLICE],
      amountCents = REFUSED_CENTS,
    ) {
      return enqueueBookingModificationRefundRecovery({
        bookingId: BOOKING_ID,
        paymentId: PAYMENT_ID,
        bookingModificationId: MODIFICATION_ID,
        amountCents,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
        allocationPlan: plan,
      });
    }

    const queuedRow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: OPERATION_KEY } });

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
      // #4096: one tier, all of it back, so the cancellation refunds the whole capture to the card.
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
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

    it("a second enqueue of the edit's refusal writes no second row, and never re-plans a row a worker holds", async () => {
      expect(await owedNow()).toBe(0);

      expect(await queueRefusedSlice()).toMatchObject({ created: true });
      expect(await queueRefusedSlice()).toMatchObject({ created: false });
      const rows = await prisma.paymentRecoveryOperation.findMany({ where: { paymentId: PAYMENT_ID } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "REFUND_BOOKING_MODIFICATION",
        status: "PENDING",
        amountCents: REFUSED_CENTS,
        stripeKeyPrefix: `mod_dates_refund_${BOOKING_ID}_${MODIFICATION_ID}`,
      });
      // Queued already on its next key: the runner's first attempt asks Stripe afresh.
      expect(parseRefundAllocationPlan(rows[0]?.allocationPlan)).toEqual([QUEUED_SLICE]);

      // A worker picks it up. A later enqueue with another plan and amount changes nothing.
      await prisma.paymentRecoveryOperation.update({
        where: { idempotencyKey: OPERATION_KEY },
        data: { status: "PROCESSING", attempts: 1, processingStartedAt: new Date("2026-06-20T00:05:00.000Z") },
      });
      expect(await queueRefusedSlice([REFUSED_SLICE, { paymentTransactionId: ADDITIONAL_TXN, amountCents: 1 }], 4_001)).toMatchObject({ created: false });
      const held = await queuedRow();
      expect(held).toMatchObject({ status: "PROCESSING", amountCents: REFUSED_CENTS });
      expect(parseRefundAllocationPlan(held.allocationPlan)).toEqual([QUEUED_SLICE]);
    });

    it("Refunds owed counts what Stripe refused, through a second refusal, until a retry makes it", async () => {
      await queueRefusedSlice();
      // Raised after the edit's refunds were recorded, as the door raises it.
      await prisma.paymentRecoveryOperation.update({ where: { idempotencyKey: OPERATION_KEY }, data: { createdAt: new Date("2026-06-20T00:00:01.000Z") } });
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The runner's retry under `refused1` is refused again: not progress.
      await recordRefund("re_race_4083_refused_again", PRIMARY_TXN, REFUSED_CENTS, "canceled", RETRIED_AT);
      expect(await owedNow()).toBe(REFUSED_CENTS);

      // The next retry is made: the slice is filled, nothing is owed.
      await recordRefund("re_race_4083_retried", PRIMARY_TXN, REFUSED_CENTS, "succeeded", new Date("2026-06-20T00:20:00.000Z"));
      expect(await owedNow()).toBe(0);
    });

    it("the runner moves a refused slice only on the attempt it holds, and never skips a generation", async () => {
      await queueRefusedSlice();
      const queued = await queuedRow();
      const claimedAt = new Date("2026-06-20T00:05:00.000Z");
      await prisma.paymentRecoveryOperation.update({
        where: { id: queued.id },
        data: { status: "PROCESSING", attempts: 1, processingStartedAt: claimedAt },
      });
      const held = (processingStartedAt: Date) => ({ id: queued.id, bookingId: BOOKING_ID, paymentIntentId: queued.paymentIntentId, processingStartedAt });
      const refusedAnswer = (slice: { paymentTransactionId: string; amountCents: number; stripeKeySuffix?: string }) => async () => ({
        refunds: [{ status: "failed", slice, refundId: "re_race_4083_runner", paymentIntentId: queued.paymentIntentId }],
      });
      const planNow = async () => parseRefundAllocationPlan((await queuedRow()).allocationPlan);
      const twice = { ...REFUSED_SLICE, stripeKeySuffix: "refused2" };

      // The attempt this worker holds: `refused1` is refused again, so it moves to `refused2`.
      await expect(
        refundPlanOrRetryRefusals({ operation: held(claimedAt), plan: [QUEUED_SLICE], format: CLUB_FORMAT_TEST, refund: refusedAnswer(QUEUED_SLICE) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);

      // A stale attempt (the reaper handed the row back and it was claimed again)
      // reads `refused2` refused too, but its fence misses: nothing moves.
      const reclaimedAt = new Date("2026-06-20T00:30:00.000Z");
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { processingStartedAt: reclaimedAt } });
      await expect(
        refundPlanOrRetryRefusals({ operation: held(claimedAt), plan: [twice], format: CLUB_FORMAT_TEST, refund: refusedAnswer(twice) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);

      // A closed row is never written, whoever reads a refusal.
      await prisma.paymentRecoveryOperation.update({ where: { id: queued.id }, data: { status: "SUCCEEDED", succeededAt: RETRIED_AT } });
      await expect(
        refundPlanOrRetryRefusals({ operation: held(reclaimedAt), plan: [twice], format: CLUB_FORMAT_TEST, refund: refusedAnswer(twice) }),
      ).rejects.toThrow(/still owed/);
      expect(await planNow()).toEqual([twice]);
    });

    describe("the REAL cancelBooking, Stripe answering the card refund refused (#4096)", () => {
      beforeEach(async () => {
        resetStripeRaceHooks();
        await deleteCancelRows();
        await prisma.booking.create({
          data: {
            id: CANCEL_BOOKING_ID,
            memberId: MEMBER_ID,
            lodgeId: LODGE_ID,
            checkIn: NIGHT,
            checkOut: CHECK_OUT,
            status: "PAID",
            totalPriceCents: CANCEL_CENTS,
            finalPriceCents: CANCEL_CENTS,
          },
        });
        await prisma.payment.create({
          data: {
            id: CANCEL_PAYMENT_ID,
            bookingId: CANCEL_BOOKING_ID,
            amountCents: CANCEL_CENTS,
            source: "STRIPE",
            status: "SUCCEEDED",
            stripePaymentIntentId: CANCEL_INTENT,
            transactions: {
              create: {
                id: CANCEL_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: CANCEL_INTENT,
                amountCents: CANCEL_CENTS,
                status: "SUCCEEDED",
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
            },
          },
        });
      });

      afterAll(async () => {
        resetStripeRaceHooks();
      });

      it.each(["failed", "canceled"])("Stripe answers %s: the booking is cancelled and its refund stays owed, re-planned on a fresh key", async (status) => {
        const asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];
        stripeRaceHooks.refund = async (args) => {
          asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
          return {
            id: `re_race_4083_cancel_${status}`,
            object: "refund",
            amount: args.amountCents,
            currency: "nzd",
            status,
            reason: "requested_by_customer",
            created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
            charge: "ch_race_4083_cancel",
            payment_intent: args.paymentIntentId,
            metadata: args.metadata ?? {},
          };
        };
        const { cancelBooking } = await import("@/lib/booking-cancel");

        const result = await cancelBooking(CANCEL_BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");

        expect(result.status).toBe(200);
        expect(asked).toEqual([{ idempotencyKey: `booking_cancel_refund_${CANCEL_BOOKING_ID}_${CANCEL_TXN}_${CANCEL_CENTS}`, amountCents: CANCEL_CENTS }]);
        expect(await prisma.booking.findUniqueOrThrow({ where: { id: CANCEL_BOOKING_ID }, select: { status: true } })).toEqual({ status: "CANCELLED" });
        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
          where: { idempotencyKey: `booking_cancel_refund_recovery_${CANCEL_BOOKING_ID}` },
        });
        expect(row).toMatchObject({
          status: "PENDING",
          attempts: 0,
          amountCents: CANCEL_CENTS,
          lastError: "Stripe refused $200.00 of this card refund (failed or cancelled), so no money went back and it is still owed.",
        });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: CANCEL_TXN, amountCents: CANCEL_CENTS, stripeKeySuffix: "refused1" },
        ]);
        // Recorded, not counted: nothing went back, and the whole refund is owed.
        expect(await prisma.paymentRefund.findMany({ where: { paymentId: CANCEL_PAYMENT_ID }, select: { status: true } })).toEqual([{ status }]);
        expect(await owedNow(CANCEL_PAYMENT_ID)).toBe(CANCEL_CENTS);
      }, 60_000);

      it("one charge refunded, the other refused: the made slice stays in the plan, marked; the amount stays the plan's; only the refused part is owed", async () => {
        // A $60.00 top-up on the $200.00 booking, refunded first (newest first).
        await prisma.paymentTransaction.update({ where: { id: CANCEL_TXN }, data: { amountCents: CANCEL_CENTS - 6_000 } });
        await prisma.paymentTransaction.create({
          data: {
            id: CANCEL_ADDITIONAL_TXN,
            paymentId: CANCEL_PAYMENT_ID,
            kind: "ADDITIONAL",
            source: "STRIPE",
            stripePaymentIntentId: CANCEL_ADDITIONAL_INTENT,
            amountCents: 6_000,
            status: "SUCCEEDED",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
          },
        });
        stripeRaceHooks.refund = async (args) => ({
          id: `re_race_4083_${args.paymentIntentId}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: args.paymentIntentId === CANCEL_ADDITIONAL_INTENT ? "succeeded" : "failed",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        });
        const { cancelBooking } = await import("@/lib/booking-cancel");

        expect((await cancelBooking(CANCEL_BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card")).status).toBe(200);

        const row = await prisma.paymentRecoveryOperation.findUniqueOrThrow({
          where: { idempotencyKey: `booking_cancel_refund_recovery_${CANCEL_BOOKING_ID}` },
        });
        expect(row).toMatchObject({ status: "PENDING", amountCents: CANCEL_CENTS });
        expect(parseRefundAllocationPlan(row.allocationPlan)).toEqual([
          { paymentTransactionId: CANCEL_ADDITIONAL_TXN, amountCents: 6_000, madeRefundId: `re_race_4083_${CANCEL_ADDITIONAL_INTENT}` },
          { paymentTransactionId: CANCEL_TXN, amountCents: CANCEL_CENTS - 6_000, stripeKeySuffix: "refused1" },
        ]);
        // The made $60.00 fills its marked slice; the refused $140.00 is owed.
        expect(await owedNow(CANCEL_PAYMENT_ID)).toBe(CANCEL_CENTS - 6_000);
      }, 60_000);
    });
  },
);
