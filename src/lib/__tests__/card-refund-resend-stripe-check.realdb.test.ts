/**
 * Real-PostgreSQL proof of #4359 (#4361 wave 1, design D; `INV-PAY-140`): the
 * recovery runner reads the refunds Stripe holds before it sends a card
 * refund, and sends nothing past a refund made outside the app since the debt
 * arose.
 *
 * Every state is reached through the real writers: the door's own record of
 * its refund (`recordStripeRefundsAgainstTransaction`), Stripe's report that
 * it failed later (`recordRefusedCardRefund`, which raises the row that owes
 * it again), and the real runner (`runPaymentRecoveryOperationNow`). Stripe is
 * the harness's one shared double (`support/stripe-race-double.ts`): what it
 * holds on the intent (`listRefunds`) and what it makes (`refund`).
 *
 * - A refund fails later, the treasurer refunds the same amount in the Stripe
 *   dashboard, then the runner's turn: it sends nothing, records the dashboard
 *   refund the app had not seen, and holds the row - FAILED, attempts spent,
 *   coded - audited, never claimed again.
 * - The same with no dashboard refund: it sends, once, and closes.
 * - A refund another app door made since: no hold.
 * - A dashboard refund made before the debt arose - while the refund was still
 *   pending, before Stripe failed it: no hold.
 * - Stripe's list cannot be read: nothing is sent, the attempt is retried, and
 *   the next attempt sends.
 *
 * Ordinary Vitest runs skip the whole file. `concurrency-lock-races.realdb.test.ts`
 * imports it so CI reaches it; it owns and cleans its own `race-4359-` fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4359-member";
const LODGE_ID = "race-4359-lodge";
const BOOKING_ID = "race-4359-booking";
const PAYMENT_ID = "race-4359-payment";
const TXN_ID = "race-4359-txn";
const INTENT_ID = "pi_race_4359";
const CHARGE_ID = "ch_race_4359";
const PAID_CENTS = 20_000;
const REFUND_CENTS = 4_000;
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
/** The door's refund, Stripe answering `pending`; Stripe fails it five days later. */
const MADE_AT = seconds("2026-06-20T00:00:05.000Z");
const FAILED_AT = seconds("2026-06-25T00:00:00.000Z");
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

const DOOR_METADATA = { bookingId: BOOKING_ID, reason: "date_change_price_decrease" };

function stripeRefund(id: string, status: string, metadata: Record<string, string> | null, created: number, extra: Partial<Stripe.Refund> = {}): Stripe.Refund {
  return {
    id, object: "refund", amount: REFUND_CENTS, currency: "nzd", status, reason: "requested_by_customer", created,
    charge: CHARGE_ID, payment_intent: INTENT_ID, metadata, ...extra,
  } as unknown as Stripe.Refund;
}
const doorRefund = (status: string) =>
  stripeRefund("re_race_4359_door", status, DOOR_METADATA, MADE_AT, status === "failed" ? { failure_balance_transaction: { id: "txn_race_4359_failure", object: "balance_transaction", created: FAILED_AT } as Stripe.BalanceTransaction } : {});

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let recordStripeRefundsAgainstTransaction: (typeof import("@/lib/payment-transactions"))["recordStripeRefundsAgainstTransaction"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
let markerFinishedAt: Date | null = null;

(RUN ? describe : describe.skip)(
  "the recovery runner reads Stripe before a card refund send - real PostgreSQL (#4359)",
  { timeout: 30_000 },
  () => {
    /** What Stripe holds on the intent, in the order it lists them, and every refund the runner asked it for. */
    let held: Stripe.Refund[] = [];
    let asked: Array<{ idempotencyKey?: string; amountCents: number }> = [];

    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
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

    async function setCutoff(at: Date) {
      await prisma.$executeRaw`UPDATE "_prisma_migrations" SET "finished_at" = ${at} WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
    }

    /**
     * The door's refund recorded `pending`, then Stripe's report that it failed (five days later, by its failure's
     * balance transaction): the refunded total falls back and one row of its own owes it again (#4104).
     */
    async function failedLaterRow() {
      held = [doorRefund("pending")];
      await recordStripeRefundsAgainstTransaction({ paymentId: PAYMENT_ID, paymentTransactionId: TXN_ID, refunds: [doorRefund("pending")], fallbackPaymentIntentId: INTENT_ID });
      held = [doorRefund("failed")];
      expect(await recordRefusedCardRefund(doorRefund("failed"))).toBe("recorded");
      return prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: "card_refund_failed_later_re_race_4359_door" } });
    }

    const row = (id: string) =>
      prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id }, select: { status: true, attempts: true, nextRetryAt: true, lastError: true } });
    const refundedTotal = async () =>
      (await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).refundedAmountCents;
    const heldAudits = () => prisma.auditLog.findMany({ where: { targetId: BOOKING_ID, action: "booking-payment.card-refund.resend-held" } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Runner pre-send Stripe check (#4359)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ recordStripeRefundsAgainstTransaction } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      // #4104's cutoff finished long before these refunds, so a failed one is re-sent rather than raised dead.
      const [marker] = await prisma.$queryRaw<Array<{ finished_at: Date }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" = ${CUTOFF_MIGRATION}`;
      if (!marker) throw new Error(`The race database lacks ${CUTOFF_MIGRATION}: run prisma migrate deploy against it first.`);
      markerFinishedAt = marker.finished_at;
      await setCutoff(new Date("2026-01-01T00:00:00.000Z"));

      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Resend", lastName: "Held", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4359 Lodge", slug: "race-4359" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      held = [];
      asked = [];
      stripeRaceHooks.listRefunds = async (paymentIntentId) => (paymentIntentId === INTENT_ID ? [...held] : []);
      stripeRaceHooks.refund = async (args) => {
        asked.push({ idempotencyKey: args.idempotencyKey, amountCents: args.amountCents });
        const made = stripeRefund(`re_race_4359_sent_${asked.length}`, "succeeded", args.metadata ?? null, seconds("2026-06-30T00:00:00.000Z"), { amount: args.amountCents });
        held.push(made);
        return made;
      };
      await deletePaymentRows();
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"),
          status: "PAID", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: INTENT_ID,
          transactions: {
            create: { id: TXN_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT_ID, amountCents: PAID_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
          },
        },
      });
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      if (markerFinishedAt) await setCutoff(markerFinishedAt);
    });

    it("MUTATION (hold): failed later, then a dashboard refund of the same amount on the same charge - the runner sends nothing and holds the row", async () => {
      const owed = await failedLaterRow();
      // The treasurer refunds the same $40 in the Stripe dashboard; no `charge.refunded` has reached the app yet.
      const dashboard = stripeRefund("re_race_4359_dashboard", "succeeded", {}, seconds("2026-06-26T00:00:00.000Z"));
      held.push(dashboard);
      expect(await refundedTotal()).toBe(0);

      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("failed");

      expect(asked).toEqual([]);
      const { CARD_REFUND_RESEND_HELD_CODE, MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants");
      const after = await row(owed.id);
      expect(after).toMatchObject({ status: "FAILED", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: null });
      expect(after.lastError).toMatch(new RegExp(`^${CARD_REFUND_RESEND_HELD_CODE}: .*re_race_4359_dashboard`));
      // The dashboard refund the app had not seen is recorded through the one writer: the member has been paid back once.
      expect(await prisma.paymentRefund.findUnique({ where: { stripeRefundId: dashboard.id }, select: { status: true, amountCents: true, paymentTransactionId: true } })).toEqual({
        status: "succeeded", amountCents: REFUND_CENTS, paymentTransactionId: TXN_ID,
      });
      expect(await refundedTotal()).toBe(REFUND_CENTS);
      expect(await heldAudits()).toHaveLength(1);
      // Given up: on the Stuck States dead list's terms, and never claimed again.
      const { deadCardRefundOperationWhere } = await import("@/lib/card-refund-paid-another-way");
      expect(await prisma.paymentRecoveryOperation.count({ where: { id: owed.id, ...deadCardRefundOperationWhere } })).toBe(1);
      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("not-claimed");
      expect(asked).toEqual([]);
      expect(await heldAudits()).toHaveLength(1);
    });

    it("failed later with no dashboard refund: the runner sends it once, and closes the row", async () => {
      const owed = await failedLaterRow();

      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(asked).toEqual([{ idempotencyKey: `card_refund_failed_later_re_race_4359_door_${TXN_ID}_${REFUND_CENTS}`, amountCents: REFUND_CENTS }]);
      expect((await row(owed.id)).status).toBe("SUCCEEDED");
      expect(await refundedTotal()).toBe(REFUND_CENTS);
      expect(await heldAudits()).toEqual([]);
    });

    it("a refund another app door made on the charge since: no hold - the runner sends", async () => {
      const owed = await failedLaterRow();
      held.push(stripeRefund("re_race_4359_other_door", "succeeded", { bookingId: BOOKING_ID, reason: "booking_cancellation" }, seconds("2026-06-26T00:00:00.000Z"), { amount: 1_000 }));

      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(asked).toHaveLength(1);
      expect((await row(owed.id)).status).toBe("SUCCEEDED");
      // The other door's refund, unseen until the read, is recorded beside the re-send.
      expect(await refundedTotal()).toBe(REFUND_CENTS + 1_000);
      expect(await heldAudits()).toEqual([]);
    });

    it("MUTATION (ordering): a dashboard refund made before the debt arose - while the refund was still pending - does not hold", async () => {
      const owed = await failedLaterRow();
      // Made on 22 June: after Stripe made the door's refund (20 June), before it failed it (25 June).
      held.push(stripeRefund("re_race_4359_dashboard_early", "succeeded", {}, seconds("2026-06-22T00:00:00.000Z")));

      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      expect(asked).toHaveLength(1);
      expect((await row(owed.id)).status).toBe("SUCCEEDED");
      expect(await heldAudits()).toEqual([]);
    });

    it("Stripe's list cannot be read: nothing is sent, the attempt retries on the backoff, and the next attempt sends", async () => {
      const owed = await failedLaterRow();
      stripeRaceHooks.listRefunds = async () => {
        throw new Error("Request timed out (race-4359)");
      };

      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("failed");

      expect(asked).toEqual([]);
      const after = await row(owed.id);
      expect(after).toMatchObject({ status: "FAILED", attempts: 1 });
      expect(after.nextRetryAt).not.toBeNull();
      expect(after.lastError).toContain("nothing was sent");
      expect(await heldAudits()).toEqual([]);

      // Stripe answers again once the backoff has passed: the runner sends.
      stripeRaceHooks.listRefunds = async () => [...held];
      await prisma.paymentRecoveryOperation.update({ where: { id: owed.id }, data: { nextRetryAt: new Date(Date.now() - 1_000) } });
      expect(await runPaymentRecoveryOperationNow(owed.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      expect(asked).toHaveLength(1);
    });
  },
);
