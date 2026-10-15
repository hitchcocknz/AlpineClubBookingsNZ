/**
 * Real-PostgreSQL proof of #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): a late
 * capture whose automatic refund went out while its record did not is recorded
 * exactly once, and the nightly self-heal never over-notes it.
 *
 * The seed is the state a delivery leaves when it dies after Stripe refunded
 * the late capture and the ledger recorded that refund, but before the record
 * row existed: the booking's own payment captured after its booking was
 * cancelled, marked by the handler's own write, refunded in full, and no
 * `ManualRefundTask` naming it. Then:
 *
 * - Before anything runs, the payment's refund-note gap - the self-heal's
 *   reader - counts the whole capture as uncovered cash: the over-note.
 * - The self-heal's check writes the lost record, and the gap closes.
 * - Two webhook redeliveries racing the self-heal still write ONE record and
 *   ONE `refunded_after_cancellation` entry, and ask Stripe for no refund (the
 *   record row is the claim, under `pg_advisory_xact_lock(1)`).
 * - A redelivery once the record exists asks Stripe nothing.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4149-` fixtures. No Stripe call is made: the refund list goes through
 * the harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4149-member";
const LODGE_ID = "race-4149-lodge";
const BOOKING_ID = "race-4149-booking";
const PAYMENT_ID = "race-4149-payment";
const LATE_TXN = "race-4149-txn-late";
const PAID_TXN = "race-4149-txn-paid";
const LATE_INTENT = "pi_race_4149_late";
const PAID_INTENT = "pi_race_4149_paid";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_CENTS = 30_000;
const KEPT_FEE_CENTS = 5_000;
const LATE_CENTS = 24_000;
const REFUND_ENTRY = "booking.payment.refunded_after_cancellation";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let webhook: typeof import("@/lib/stripe-webhook-service");
let recovery: typeof import("@/lib/late-capture-record-recovery");
let readRefundCreditNoteGap: (typeof import("@/lib/xero-admin-health"))["readRefundCreditNoteGap"];
let eventSequence = 0;

/** The late-capture door's refund of the capture, as Stripe lists it. */
function lateCaptureRefund(): Stripe.Refund {
  return {
    id: "re_race_4149_late",
    object: "refund",
    amount: LATE_CENTS,
    currency: "nzd",
    status: "succeeded",
    reason: "requested_by_customer",
    created: Math.floor(Date.parse("2026-06-25T00:00:00.000Z") / 1000),
    charge: `ch_${LATE_INTENT}`,
    payment_intent: LATE_INTENT,
    metadata: { bookingId: BOOKING_ID, reason: "cancelled_booking_late_capture" },
  } as unknown as Stripe.Refund;
}

(RUN ? describe : describe.skip)(
  "a late capture's lost automatic-refund record is written once and never over-noted - real PostgreSQL (#4149)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4149_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4149_" } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
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
      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * What the dead delivery left: the cancel's own refund of the paid charge
     * (all but a kept fee, its credit note linked in Xero), and the late
     * capture - the handler's marked write - refunded in full with that refund
     * recorded, and no record row.
     */
    async function seedAfterTheCrash() {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS + LATE_CENTS,
          refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS + LATE_CENTS,
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
          stripePaymentIntentId: PAID_INTENT,
          xeroInvoiceId: "inv-race-4149",
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          transactions: {
            create: [
              {
                id: PAID_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: PAID_INTENT,
                amountCents: PAID_CENTS,
                refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS,
                status: "PARTIALLY_REFUNDED",
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
              {
                id: LATE_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: LATE_INTENT,
                amountCents: LATE_CENTS,
                refundedAmountCents: LATE_CENTS,
                status: "REFUNDED",
                // The primary handler's own write, before its refund (#3639).
                reason: "cancelled_booking_late_capture",
                createdAt: new Date("2026-06-25T00:00:00.000Z"),
              },
            ],
          },
        },
      });
      await prisma.paymentRefund.createMany({
        data: [
          {
            paymentId: PAYMENT_ID,
            paymentTransactionId: PAID_TXN,
            stripeRefundId: "re_race_4149_cancel",
            stripePaymentIntentId: PAID_INTENT,
            amountCents: PAID_CENTS - KEPT_FEE_CENTS,
            currency: "nzd",
            status: "succeeded",
            stripeCreatedAt: new Date("2026-05-20T00:00:00.000Z"),
          },
          {
            paymentId: PAYMENT_ID,
            paymentTransactionId: LATE_TXN,
            stripeRefundId: "re_race_4149_late",
            stripePaymentIntentId: LATE_INTENT,
            amountCents: LATE_CENTS,
            currency: "nzd",
            status: "succeeded",
            stripeCreatedAt: new Date("2026-06-25T00:00:00.000Z"),
          },
        ],
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment",
          localId: PAYMENT_ID,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn-race-4149-cancel",
          role: "REFUND_CREDIT_NOTE",
          metadata: { amountCents: PAID_CENTS - KEPT_FEE_CENTS, invoiceId: "inv-race-4149" },
        },
      });
    }

    /** Stripe's redelivery of `payment_intent.succeeded` for the late capture - the real webhook processor. */
    async function redeliverLateCapture() {
      eventSequence += 1;
      const event = {
        id: `evt_race_4149_${eventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: {
          object: {
            id: LATE_INTENT,
            object: "payment_intent",
            amount: LATE_CENTS,
            currency: "nzd",
            status: "succeeded",
            payment_method: "pm_race_4149",
            metadata: { bookingId: BOOKING_ID },
            latest_charge: null,
          },
        },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    /** Stripe lists the late-capture door's refund; any refund asked for is recorded, so a second refund would show. */
    function armStripe() {
      const calls = { listed: 0, refundsAsked: 0 };
      stripeRaceHooks.listRefunds = async () => {
        calls.listed += 1;
        return [lateCaptureRefund()];
      };
      stripeRaceHooks.refund = async () => {
        calls.refundsAsked += 1;
        throw new Error("no refund may be asked for: the capture was refunded before the crash");
      };
      return calls;
    }

    const recordRows = () =>
      prisma.manualRefundTask.findMany({
        where: { bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
        select: { status: true, kind: true, reason: true, amountCents: true },
      });

    /**
     * `logAudit` is fire-and-forget: wait (real time - `Date` is frozen) for
     * the expected rows rather than racing them.
     */
    async function refundEntries(expected: number) {
      const startedAt = process.hrtime.bigint();
      for (;;) {
        const rows = await prisma.auditLog.findMany({
          where: { targetId: BOOKING_ID, action: REFUND_ENTRY },
          select: { details: true },
        });
        if (rows.length >= expected || realElapsedMs(startedAt) > 3_000) return rows;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const uncoveredCents = async () =>
      (
        await readRefundCreditNoteGap(
          await prisma.payment.findUniqueOrThrow({
            where: { id: PAYMENT_ID },
            select: { id: true, bookingId: true, refundedAmountCents: true },
          }),
        )
      ).uncoveredCents;

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "late-capture record recovery"); // the one shared guard (INV-SSOT-001)
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      webhook = await import("@/lib/stripe-webhook-service");
      recovery = await import("@/lib/late-capture-record-recovery");
      ({ readRefundCreditNoteGap } = await import("@/lib/xero-admin-health"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Lost",
          lastName: "Record",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4149 Lodge", slug: "race-4149" } });
    }, 120_000); // cold import of the webhook module graph

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      await seedAfterTheCrash();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("the self-heal writes the lost record before it could raise a note, and the over-note it would have raised is gone", async () => {
      const stripe = armStripe();
      // The defect: no record, so the capture's refund reads as uncovered cash
      // against the pre-cancel invoice.
      expect(await uncoveredCents()).toBe(LATE_CENTS);

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });

      const rows = await recordRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "DISMISSED", kind: "AUTOMATIC_LATE_CAPTURE_RECORD", amountCents: LATE_CENTS });
      expect(rows[0]?.reason).toContain(LATE_INTENT);
      expect(await uncoveredCents()).toBe(0);
      const entries = await refundEntries(1);
      expect(entries).toHaveLength(1);
      expect(JSON.parse(String(entries[0]?.details))).toMatchObject({ paymentIntentId: LATE_INTENT, recoveredLostRecord: true });
      expect(stripe.refundsAsked).toBe(0);
    });

    it("two redeliveries racing the self-heal still write one record and one entry, and refund nothing again", async () => {
      const stripe = armStripe();

      const [first, second, healed] = await Promise.all([
        redeliverLateCapture(),
        redeliverLateCapture(),
        recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID),
      ]);

      expect(first.init?.status ?? 200).toBe(200);
      expect(second.init?.status ?? 200).toBe(200);
      expect(healed.unresolved).toBe(false);
      expect(await recordRows()).toHaveLength(1);
      // Give any second (wrong) entry the same time to land as the first.
      await refundEntries(2);
      expect(await refundEntries(1)).toHaveLength(1);
      expect(stripe.refundsAsked).toBe(0);
      expect(await uncoveredCents()).toBe(0);
    });

    it("a redelivery once the record exists asks Stripe nothing and writes nothing", async () => {
      armStripe();
      await recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID);
      await refundEntries(1);
      const stripe = armStripe();

      expect((await redeliverLateCapture()).init?.status ?? 200).toBe(200);

      expect(stripe.listed).toBe(0);
      expect(await recordRows()).toHaveLength(1);
      expect(await refundEntries(2)).toHaveLength(1);
    });
  },
);
