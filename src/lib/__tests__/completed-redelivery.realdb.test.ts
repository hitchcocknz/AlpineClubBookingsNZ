/**
 * Real-PostgreSQL proof of #4285 (`INV-PAY-043`): a card capture's success
 * arriving on a booking the completion cron has since moved PAID -> COMPLETED.
 *
 * Before #4285 the settle threw "Booking is not payable from status COMPLETED"
 * for every such capture, so Stripe's redelivery of the capture that paid for
 * the stay answered 500 and was retried for up to three days. A COMPLETED
 * booking is a PAID one whose stay has ended: the recorded settler (or, paid
 * before the record existed, the booking's only capture) answers
 * `already_paid`, and any other capture meets the same duplicate-capture guard
 * as on a PAID booking.
 *
 * Every step runs through the real writers: the card settles through
 * `processStripeWebhookEvent`, the booking completes through the real
 * `completeBookings` cron, and the redelivery is another
 * `payment_intent.succeeded` through `processStripeWebhookEvent`. The only
 * fixture writes are the booking itself, the intents' PENDING rows each tab
 * minted, a change fee recorded on the payment after the stay (as a later
 * correction would), the second tab's capture set SUCCEEDED by hand for a
 * booking paid before #4211, and for such a booking clearing the record the
 * draining colour never wrote. An officer's refund in the Stripe dashboard and
 * Stripe's decline and cancel arrive as `charge.refunded`,
 * `payment_intent.payment_failed` and `payment_intent.canceled` through the same
 * webhook processor, and the deploy query (`docs/UPGRADING.md`, #4285) runs
 * exactly as the doc prints it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it
 * (`completed-redelivery-realdb-wiring.test.ts` pins the edge); it owns and
 * cleans its own `race-4285-` fixtures. No Stripe call is made: the refund goes
 * to the harness's one shared `@/lib/stripe` double.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4285-member";
const OFFICER_ID = "race-4285-officer";
const LODGE_ID = "race-4285-lodge";
const ROOM_ID = "race-4285-room";
const BOOKING_ID = "race-4285-booking";
const PAYMENT_ID = "race-4285-payment";
const PRICE_CENTS = 20_000;
// A stay that ended before the frozen today (2026-07-01), so the real
// completion cron moves the paid booking to COMPLETED.
const NIGHT_1 = new Date("2026-06-20T00:00:00.000Z");
const NIGHT_2 = new Date("2026-06-21T00:00:00.000Z");
const CHECK_OUT = new Date("2026-06-22T00:00:00.000Z");
const MINTED_AT = new Date("2026-06-10T00:00:00.000Z");

/** The settling capture and a second tab's capture, in mint order. */
const SETTLING = "pi_race_4285_settling";
const OTHER = "pi_race_4285_other";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a card capture's success arriving on a COMPLETED booking - real PostgreSQL (#4285)",
  { timeout: 120_000 },
  () => {
    let webhookEventSequence = 0;

    async function deleteBookingRows() {
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4285_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4285_" } } });
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: BOOKING_ID } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: [BOOKING_ID, PAYMENT_ID] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
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
      await prisma.lodgeBed.deleteMany({ where: { roomId: ROOM_ID } });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** Stripe makes every refund it is asked for, recording the intents asked. */
    function stripeMakesRefunds(): string[] {
      const asked: string[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.paymentIntentId);
        return {
          id: `re_race_4285_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
          charge: `ch_race_4285_${args.paymentIntentId}`,
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    /** Stripe's `payment_intent.succeeded` for one intent, through the real webhook processor; a fresh event id each time. */
    async function deliverWebhook(paymentIntentId: string, type = "payment_intent.succeeded") {
      webhookEventSequence += 1;
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const event = {
        id: `evt_race_4285_${webhookEventSequence}`,
        object: "event",
        type,
        request: null,
        data: {
          object: {
            id: paymentIntentId,
            object: "payment_intent",
            amount: PRICE_CENTS,
            currency: "nzd",
            status: type === "payment_intent.succeeded" ? "succeeded" : type === "payment_intent.canceled" ? "canceled" : "requires_payment_method",
            payment_method: "pm_race_4285",
            metadata: { bookingId: BOOKING_ID },
            latest_charge: null,
            cancellation_reason: null,
            last_payment_error: null,
          },
        },
      } as unknown as import("stripe").Stripe.Event;
      return processStripeWebhookEvent(event);
    }

    async function answeredWith(paymentIntentId: string, type: string) {
      return (await deliverWebhook(paymentIntentId, type)).init?.status ?? 200;
    }

    async function expectAnswered(paymentIntentId: string, status: number) {
      const delivered = await deliverWebhook(paymentIntentId);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(status);
    }

    /** An officer refunds a card payment by hand in the Stripe dashboard: Stripe's `charge.refunded`, through the real webhook processor. */
    async function chargeRefundedInStripe(paymentIntentId: string) {
      webhookEventSequence += 1;
      const refund = {
        id: `re_race_4285_dashboard_${paymentIntentId}`,
        object: "refund",
        amount: PRICE_CENTS,
        currency: "nzd",
        status: "succeeded",
        reason: "requested_by_customer",
        created: Math.floor(Date.UTC(2026, 6, 1) / 1000),
        charge: `ch_race_4285_${paymentIntentId}`,
        payment_intent: paymentIntentId,
        metadata: {},
      };
      stripeRaceHooks.listChargeRefunds = async () => [refund];
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const delivered = await processStripeWebhookEvent({
        id: `evt_race_4285_${webhookEventSequence}`,
        object: "event",
        type: "charge.refunded",
        request: null,
        data: {
          object: {
            id: `ch_race_4285_${paymentIntentId}`,
            object: "charge",
            payment_intent: paymentIntentId,
            amount: PRICE_CENTS,
            amount_refunded: PRICE_CENTS,
            refunds: { data: [refund] },
          },
        },
      } as unknown as import("stripe").Stripe.Event);
      expect(delivered.init?.status ?? 200, JSON.stringify(delivered.body)).toBe(200);
    }

    /** The settle itself, for its outcome (the webhook only answers 200 or 500). */
    async function arrive(paymentIntentId: string) {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
      return markBookingPaymentSucceeded({
        bookingId: BOOKING_ID,
        paymentIntentId,
        amountCents: PRICE_CENTS,
        paymentMethodId: null,
        format: CLUB_FORMAT_TEST,
      });
    }

    /** Settle by card through the webhook, then complete the stay through the real cron. */
    async function settleAndComplete() {
      await expectAnswered(SETTLING, 200);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("PAID");
      const { completeBookings } = await import("@/lib/cron-complete-bookings");
      expect((await completeBookings()).completedBookingIds).toContain(BOOKING_ID);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } })).status).toBe("COMPLETED");
    }

    /** Everything a redelivery could change, read in one place. */
    async function snapshot() {
      const [booking, payment, transactions, operations, refunds, events] = await Promise.all([
        prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } }),
        prisma.payment.findUniqueOrThrow({
          where: { id: PAYMENT_ID },
          select: { status: true, amountCents: true, refundedAmountCents: true, settledByTransactionId: true },
        }),
        prisma.paymentTransaction.findMany({
          where: { paymentId: PAYMENT_ID },
          orderBy: { stripePaymentIntentId: "asc" },
          select: { stripePaymentIntentId: true, status: true, amountCents: true, refundedAmountCents: true },
        }),
        prisma.paymentRecoveryOperation.findMany({
          where: { bookingId: BOOKING_ID },
          orderBy: { idempotencyKey: "asc" },
          select: { idempotencyKey: true, status: true, amountCents: true },
        }),
        prisma.paymentRefund.findMany({
          where: { paymentId: PAYMENT_ID },
          orderBy: { stripeRefundId: "asc" },
          select: { stripeRefundId: true, amountCents: true, status: true },
        }),
        prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } }),
      ]);
      return { booking, payment, transactions, operations, refunds, events };
    }

    /** The intent of the row `Payment.settledByTransactionId` names (#4211). */
    async function recordedSettlerIntent() {
      const { settledByTransactionId } = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { settledByTransactionId: true },
      });
      if (!settledByTransactionId) return null;
      return (
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { id: settledByTransactionId },
          select: { stripePaymentIntentId: true },
        })
      ).stripePaymentIntentId;
    }

    /** A booking paid before #4211 (or by the draining colour): no record of its settler. */
    async function clearRecordedSettler() {
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "COMPLETED redelivery proof");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: "Finished",
            lastName: "Stay",
            ageTier: "ADULT",
          },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4285 Lodge", slug: "race-4285" } });
      await prisma.lodgeRoom.create({ data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Race 4285 Room" } });
      await prisma.lodgeBed.createMany({
        data: Array.from({ length: 4 }, (_, index) => ({
          id: `race-4285-bed-${index}`,
          roomId: ROOM_ID,
          name: `Bed ${index}`,
          bedType: "SINGLE" as const,
        })),
      });
    }, 120_000);

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deleteBookingRows();
      await prisma.booking.create({
        // Admitted by an officer over capacity (#1771), so the settle's capacity
        // check passes on a lodge this suite gives no capacity setting.
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT_1,
          checkOut: CHECK_OUT,
          status: "PAYMENT_PENDING",
          totalPriceCents: PRICE_CENTS,
          finalPriceCents: PRICE_CENTS,
          capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
          capacityOverriddenByMemberId: OFFICER_ID,
        },
      });
      for (const guest of ["g1", "g2"]) {
        await prisma.bookingGuest.create({
          data: {
            id: `${BOOKING_ID}-${guest}`,
            bookingId: BOOKING_ID,
            firstName: "Finished",
            lastName: guest,
            ageTier: "ADULT",
            isMember: true,
            stayStart: NIGHT_1,
            stayEnd: CHECK_OUT,
            priceCents: PRICE_CENTS / 2,
            nights: {
              create: [
                { stayDate: NIGHT_1, priceCents: PRICE_CENTS / 4, priceSource: "SOLD" },
                { stayDate: NIGHT_2, priceCents: PRICE_CENTS / 4, priceSource: "SOLD" },
              ],
            },
          },
        });
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS,
          source: "STRIPE",
          status: "PENDING",
          stripePaymentIntentId: OTHER,
        },
      });
      // Each tab minted its intent, so each has its PENDING row, in mint order.
      for (const paymentIntentId of [SETTLING, OTHER]) {
        await prisma.paymentTransaction.create({
          data: {
            paymentId: PAYMENT_ID,
            kind: "PRIMARY",
            source: "STRIPE",
            stripePaymentIntentId: paymentIntentId,
            amountCents: PRICE_CENTS,
            status: "PENDING",
            createdAt: MINTED_AT,
          },
        });
      }
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await deleteFixtures();
    });

    it("the recorded settler's redelivery on a COMPLETED booking answers already paid and changes nothing", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      expect(await recordedSettlerIntent()).toBe(SETTLING);
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked, "nothing is refunded").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(before.booking.status).toBe("COMPLETED");
    });

    it("a booking paid before the record existed: its only capture's redelivery answers already paid, with no alert", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(0);
    });

    it("another capture on a COMPLETED booking is refunded as a duplicate, the settler kept and the booking still COMPLETED; its replay changes nothing", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      const after = await snapshot();
      expect(after.booking.status).toBe("COMPLETED");
      expect(after.transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "REFUNDED"],
        [SETTLING, "SUCCEEDED"],
      ]);
      expect(after.operations.map((operation) => [operation.idempotencyKey, operation.status])).toEqual([
        [`duplicate_capture_${BOOKING_ID}_${OTHER}`, "SUCCEEDED"],
      ]);
      expect(await recordedSettlerIntent()).toBe(SETTLING);

      // Both captures redelivered again: nothing moves.
      await expectAnswered(OTHER, 200);
      await expectAnswered(SETTLING, 200);
      expect(asked, "no refund is asked for again").toEqual([OTHER]);
      expect(await snapshot()).toEqual(after);
    });

    it("a change fee recorded after the stay: another capture's webhook at the old amount is refunded in full, not refused as a stale intent", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // A later correction records a fee on the payment, so the booking now owes more.
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      const after = await snapshot();
      expect(after.refunds.map((refund) => refund.amountCents)).toEqual([PRICE_CENTS]);
      expect(after.transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "REFUNDED"],
        [SETTLING, "SUCCEEDED"],
      ]);
    });

    /** The UPGRADING deploy query, as an operator runs it: the booking ids it lists. */
    async function deployQueryLists() {
      const { completedRedeliveryDeployQuery } = await import("./support/completed-redelivery-deploy-query");
      const rows = await prisma.$queryRawUnsafe<Array<{ bookingId: string }>>(completedRedeliveryDeployQuery());
      return rows.map((row) => row.bookingId).filter((id) => id === BOOKING_ID);
    }

    it("the deploy query lists a finished stay whose second card payment may have captured, until the app refunds it", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // The second tab's success, refused before #4285, never wrote its row: still PENDING.
      expect(await deployQueryLists()).toEqual([BOOKING_ID]);

      await expectAnswered(OTHER, 200);
      expect(asked).toEqual([OTHER]);
      expect(await deployQueryLists(), "a refunded, duplicate-owned capture is not listed").toEqual([]);
    });

    it("#4285 review F5: a declined intent stays listed (it can still be paid); one Stripe cancelled is not", async () => {
      await settleAndComplete();

      expect(await answeredWith(OTHER, "payment_intent.payment_failed")).toBe(200);
      expect((await snapshot()).transactions.map((row) => [row.stripePaymentIntentId, row.status])).toEqual([
        [OTHER, "FAILED"],
        [SETTLING, "SUCCEEDED"],
      ]);
      expect(await deployQueryLists(), "a declined first try the member may then have paid").toEqual([BOOKING_ID]);

      expect(await answeredWith(OTHER, "payment_intent.canceled")).toBe(200);
      // The webhook's audit entry is written after its answer.
      await vi.waitFor(async () => {
        expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking.payment.canceled" } })).toBe(1);
      });
      expect(await deployQueryLists(), "an intent Stripe cancelled cannot be paid").toEqual([]);
    });

    it("#4285 review F3: a booking paid before the record existed, its only capture replayed after a fee raised what it owes: a replay, already paid, no alert", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(SETTLING)).outcome).toBe("already_paid");

      expect(asked).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await prisma.alertCooldown.count({ where: { key: { contains: BOOKING_ID } } })).toBe(0);
    });

    it("#4285 review F3: no record and nothing else holding money (the only payment refunded in Stripe): a second tab's payment the app never recorded is kept and the admins told", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      await chargeRefundedInStripe(SETTLING);
      expect((await snapshot()).transactions.find((row) => row.stripePaymentIntentId === SETTLING)?.status).toBe("REFUNDED");

      await expectAnswered(OTHER, 200);

      expect(asked, "nothing is refunded automatically").toEqual([]);
      const after = await snapshot();
      expect(after.booking.status).toBe("COMPLETED");
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("SUCCEEDED");
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } })).map((row) => row.key),
        "the kept-capture alert's once-a-day claim",
      ).toEqual([`duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`]);

      // Its replay is now a replay: kept quietly, no second alert window.
      expect((await arrive(OTHER)).outcome).toBe("already_paid");
    });

    it("#4285 review F1/F2: a booking the deploy query lists (no record): a resend is kept and alerted, never refunded; the officer's refund in Stripe is recorded and queues a credit note", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      await clearRecordedSettler();
      expect(await deployQueryLists()).toEqual([BOOKING_ID]);

      // Step 1: the event resent from Stripe.
      await expectAnswered(OTHER, 200);
      expect(asked, "a resend refunds nothing: there is no record of which payment settled the booking").toEqual([]);
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } })).map((row) => row.key),
      ).toEqual([`duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`]);
      expect(await deployQueryLists(), "still listed until someone refunds it").toEqual([BOOKING_ID]);

      // Step 2: refunded by hand in the Stripe dashboard.
      const notesBefore = await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } });
      await chargeRefundedInStripe(OTHER);
      const after = await snapshot();
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("REFUNDED");
      expect(after.refunds.map((refund) => refund.stripeRefundId)).toEqual([`re_race_4285_dashboard_${OTHER}`]);
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } }), "a refund credit note is queued (#4322)").toBe(notesBefore + 1);
      expect(await deployQueryLists()).toEqual([]);
    });

    it("#4285 review F2: refunded by hand in Stripe with no resend, the app still records the refund and queues a credit note", async () => {
      await settleAndComplete();
      await clearRecordedSettler();
      const notesBefore = await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } });

      await chargeRefundedInStripe(OTHER);

      const after = await snapshot();
      expect(after.refunds.map((refund) => refund.stripeRefundId)).toEqual([`re_race_4285_dashboard_${OTHER}`]);
      expect(after.transactions.find((row) => row.stripePaymentIntentId === OTHER)?.status).toBe("REFUNDED");
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } })).toBe(notesBefore + 1);
      expect(await deployQueryLists()).toEqual([]);
    });

    it("a booking paid before the record existed, another capture holding money: the arriving capture is kept, nothing refunded, and the admins alerted", async () => {
      const asked = stripeMakesRefunds();
      await settleAndComplete();
      // The other tab's capture is recorded too, before the record existed.
      await prisma.paymentTransaction.updateMany({
        where: { paymentId: PAYMENT_ID, stripePaymentIntentId: OTHER },
        data: { status: "SUCCEEDED" },
      });
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      await clearRecordedSettler();
      const before = await snapshot();

      await expectAnswered(SETTLING, 200);
      expect((await arrive(OTHER)).outcome).toBe("duplicate_capture_kept");

      expect(asked, "nothing is refunded automatically").toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(
        (await prisma.alertCooldown.findMany({ where: { key: { contains: BOOKING_ID } }, select: { key: true } }))
          .map((row) => row.key)
          .sort(),
      ).toEqual([
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${OTHER}`,
        `duplicate-capture-unrecorded-settler:${BOOKING_ID}:${SETTLING}`,
      ]);
    });
  },
);
