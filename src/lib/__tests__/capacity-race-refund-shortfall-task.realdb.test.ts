/**
 * Real-PostgreSQL proof of #4154 (`INV-PAY-133`): the part of a capacity race's
 * charge its card refund plan does not carry is a hand-back task to check,
 * raised with the cancel, which the officers can close either way.
 *
 * What a mock can only imitate, run here against the database through the REAL
 * capacity race (`markBookingPaymentSucceeded` losing the capacity claim), the
 * REAL `resolveManualRefundTask`, the REAL recovery runner
 * (`runPaymentRecoveryOperationNow`) and the booking page's own reads:
 *
 * - A partial plan (the charge's ledger row already reads $60.00 refunded with
 *   no refund row behind it - the records drift #4125 refunds around): the card
 *   refunds $140.00 and the void's own transaction writes ONE
 *   `CANCELLED_BOOKING_HAND_BACK` to CHECK for $60.00, passing every
 *   `ManualRefundTask` CHECK. The capture's success delivered again through
 *   the webhook door settles nothing more and writes no second. The card refund
 *   ADDS to the drifted total, so the charge reads all of it refunded and the
 *   census reports the drift. Marked paid back, the owner's guarded
 *   recalculation (`INV-PAY-133`) lowers the charge to its refund rows, audited
 *   before and after, and the task lands on that charge alone (never on a
 *   charge captured later on the payment, its own case) - posting its `BANK_REFUND` line and ONE Xero refund
 *   note keyed on the task; the member's page reads the whole charge refunded
 *   and the census agrees.
 * - An empty plan whose records drifted (the row reads the whole charge
 *   refunded): nothing by card; marked paid back, corrected to nothing, and the
 *   whole $200.00 is recorded the same way, the census agreeing.
 * - The card refund still being sent (Stripe unreachable): refused (409),
 *   nothing corrected, until the runner makes the race's refund.
 * - A charge made before the refund ledger started: never corrected - refused
 *   naming why, nothing written - and dismissed, the page says the club closed it.
 *
 * "Refunds owed" is not read: it is club-wide, and capped at what a payment's
 * records still hold, which here read the whole charge refunded.
 *
 * Every refund the double makes is dated after this database's refund ledger
 * started, as a live one is: an earlier date reads as a pre-ledger refund
 * (`refundLedgerStartSeconds`), which is NOT added to the total.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4154-` fixtures. No Stripe call is made: the refund goes to the
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

const MEMBER_ID = "race-4154-member";
const LODGE_ID = "race-4154-lodge";
const BOOKING_ID = "race-4154-booking";
const PAYMENT_ID = "race-4154-payment";
const CARD_TXN = "race-4154-txn-card";
const GUESTS = ["race-4154-g1", "race-4154-g2"];
const INTENT = "pi_race_4154";
const CHARGE_CENTS = 20_000;
const DRIFT_CENTS = 6_000;
const CHECK_KEY = `cancel-card-shortfall:${BOOKING_ID}:capacity-race:${INTENT}:check`;
const LATE_TXN = "race-4154-txn-late";
const LATE_INTENT = "pi_race_4154_late";
// After this database's refund ledger started (its migration runs at real time), as a live charge's is; the
// double's refunds are later still. A charge from before it is one the correction must refuse (`INV-PAY-133`).
const CHARGE_MADE_AT = new Date("2098-06-01T00:00:00.000Z");
const LATE_CHARGE_MADE_AT = new Date("2098-07-01T00:00:00.000Z");
const CORRECTION_ACTION = "booking-payment.capacity-race.refunded-total-corrected";
const RACE_ROW_KEY = `capacity_claim_failed_refund_recovery_${BOOKING_ID}_${INTENT}`;
const XERO_INVOICE_ID = "race-4154-invoice";
// A stay well after today.
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Capacity-race shortfall task proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run capacity-race shortfall task proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Capacity-race shortfall task proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Capacity-race shortfall task proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a capacity race's refund shortfall is a hand-back task to check - real PostgreSQL (#4154)",
  { timeout: 60_000 },
  () => {
    async function clean(): Promise<void> {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    /**
     * A $200 booking - two guests, two nights at $50 - awaiting its card
     * payment, at a lodge with no beds, so the final capacity claim fails. Its
     * payment's ledger already holds the card charge, reading `refundedCents`
     * of it refunded with no refund row (the drift).
     */
    async function seed({ refundedCents, chargeMadeAt = CHARGE_MADE_AT }: { refundedCents: number; chargeMadeAt?: Date }): Promise<void> {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "PAYMENT_PENDING", totalPriceCents: CHARGE_CENTS, finalPriceCents: CHARGE_CENTS },
      });
      for (const id of GUESTS) {
        await prisma.bookingGuest.create({
          data: {
            id,
            bookingId: BOOKING_ID,
            firstName: "Shortfall",
            lastName: id,
            ageTier: "ADULT",
            isMember: true,
            stayStart: D1,
            stayEnd: CHECK_OUT,
            priceCents: 10_000,
            nights: { create: [{ stayDate: D1, priceCents: 5_000, priceSource: "SOLD" }, { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" }] },
          },
        });
      }
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: CHARGE_CENTS, source: "STRIPE", status: "PENDING", stripePaymentIntentId: INTENT, xeroInvoiceId: XERO_INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: CARD_TXN, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT, amountCents: CHARGE_CENTS, refundedAmountCents: refundedCents, status: "SUCCEEDED", createdAt: chargeMadeAt },
      });
    }

    /** Stripe makes every refund it is asked for, or (`unreachable`) cannot be reached. */
    function stripeRefunds(answer: "make" | "unreachable") {
      const asked: number[] = [];
      stripeRaceHooks.refund = async (args) => {
        asked.push(args.amountCents);
        if (answer === "unreachable") throw new Error("race-4154: Stripe unreachable");
        return {
          id: `re_race_4154_${asked.length}`,
          object: "refund",
          amount: args.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: "requested_by_customer",
          // After the refund ledger started on this database (its migration ran at real time).
          created: Math.floor(Date.UTC(2099, 0, 1) / 1000),
          charge: "ch_race_4154",
          payment_intent: args.paymentIntentId,
          metadata: args.metadata ?? {},
        };
      };
      return asked;
    }

    /** The card payment completing after the dates filled. */
    async function capacityRace() {
      const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");
      return markBookingPaymentSucceeded({ bookingId: BOOKING_ID, paymentIntentId: INTENT, amountCents: CHARGE_CENTS, paymentMethodId: null, format: CLUB_FORMAT_TEST });
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

    /** Every refund credit note queued on the payment by a task: its amount and the task. */
    async function taskRefundNotes(): Promise<Array<{ cents: unknown; taskId: unknown }>> {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE", operationType: "CREATE" },
        select: { requestPayload: true },
      });
      return rows
        .map(({ requestPayload }) => {
          const payload = (requestPayload ?? {}) as Record<string, unknown>;
          return { cents: payload.refundAmountCents, taskId: payload.paidAnotherWayTaskId ?? null };
        })
        .filter((note) => note.taskId !== null);
    }

    /** The member's booking page, from what is stored: its events and the live reads it makes. */
    async function memberPage(): Promise<string> {
      const { resolveBookingNarrative } = await import("@/lib/booking-narrative");
      const { readCancelledCardRefundState, readCardShortfallTaskStatuses } = await import("@/lib/cancel-card-refund-shortfall-status");
      const { bindClubTime, requireClubTimeZone } = await import("@/lib/club-time");
      const events = await prisma.bookingEvent.findMany({ where: { bookingId: BOOKING_ID }, select: { type: true, occurredAt: true, amountCents: true, reason: true, snapshot: true } });
      return resolveBookingNarrative(
        {
          club: bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST),
          booking: { status: "CANCELLED", finalPriceCents: CHARGE_CENTS, amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 }, checkIn: D1, checkOut: CHECK_OUT, firstName: "Shortfall", adminReviewStatus: null, adminReviewNotes: null, adminReviewReason: null },
          events,
          cardShortfallStatuses: await readCardShortfallTaskStatuses(BOOKING_ID),
          cardRefundState: await readCancelledCardRefundState(BOOKING_ID),
        },
        CLUB_FORMAT_TEST,
      ).message;
    }

    const checkTask = () => prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: CHECK_KEY } });
    const corrections = () => prisma.auditLog.findMany({ where: { targetId: BOOKING_ID, action: CORRECTION_ACTION }, select: { category: true, entityId: true, metadata: true } });
    const lateCharge = (amountCents: number) =>
      prisma.paymentTransaction.create({
        data: { id: LATE_TXN, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: LATE_INTENT, amountCents, status: "SUCCEEDED", createdAt: LATE_CHARGE_MADE_AT },
      });

    /** #4147's census of the booking, after the back-post confirms it on the ledger (`apply`). */
    async function census(backPost?: "apply") {
      const { runBookingLedgerBackPost } = await import("@/lib/booking-ledger-back-post");
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      const posted = backPost ? (await runBookingLedgerBackPost({ client: prisma, apply: true, bookingIds: [BOOKING_ID] })).outcomes[0]! : null;
      const evaluation = evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, BOOKING_ID))!);
      return {
        posted,
        price: evaluation.identities.find((each) => each.identity === "PRICE")!,
        disagreements: evaluation.identities.filter((each) => each.status === "DISAGREE").map((each) => each.identity),
        integrity: evaluation.integrity,
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Capacity", lastName: "Shortfall", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4154 Lodge", slug: "race-4154" } });
    });

    beforeEach(async () => {
      resetStripeRaceHooks();
      await clean();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    it("a partial plan: the card refunds what it carries, the rest is ONE task to check; marked paid back, the drifted charge is corrected and takes it - line, Xero note, audit, and the census agrees", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      const asked = stripeRefunds("make");

      expect((await capacityRace()).outcome).toBe("cancelled_refunded");
      expect(asked).toEqual([CHARGE_CENTS - DRIFT_CENTS]);
      const tasks = await prisma.manualRefundTask.findMany({ where: { bookingId: BOOKING_ID } });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        kind: "CANCELLED_BOOKING_HAND_BACK",
        status: "OPEN",
        occurrenceKey: CHECK_KEY,
        paymentId: PAYMENT_ID,
        amountCents: DRIFT_CENTS,
        raisedAmountCents: DRIFT_CENTS,
      });
      expect(tasks[0]!.reason).toContain("Check Stripe and the bank before paying");
      // Until it is closed, the member's page says the club will be in touch about it.
      expect(await memberPage()).toContain("$140.00 was refunded on 1 Jul 2026; the club will be in touch about the remaining $60.00.");

      // The capture's success delivered again (a fresh event for the same intent), through the real webhook door:
      // the booking is cancelled, so it is acknowledged, refunds nothing more and writes no second task.
      const { processStripeWebhookEvent } = await import("@/lib/stripe-webhook-service");
      const again = await processStripeWebhookEvent({
        id: "evt_race_4154_again",
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: { object: { id: INTENT, object: "payment_intent", amount: CHARGE_CENTS, amount_received: CHARGE_CENTS, currency: "nzd", status: "succeeded", payment_method: null, latest_charge: "ch_race_4154", metadata: { bookingId: BOOKING_ID } } },
      } as never);
      expect(again).toEqual({ body: { received: true } });
      expect(asked).toHaveLength(1);
      expect(await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).toEqual({ status: "CANCELLED" });
      expect(await prisma.paymentRecoveryOperation.count({ where: { bookingId: BOOKING_ID } })).toBe(1);
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID, type: "REFUNDED" } })).toBe(1);
      expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(1);

      // The card refund was ADDED to the drifted total (a live refund, after the ledger started): the charge reads all of it refunded,
      // and the census reports the drift - the back-post will not confirm over a refunded total its refund rows do not make.
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect((await census("apply")).posted).toMatchObject({ kind: "CANNOT_POST", disagreements: [{ identity: "REFUNDED", deltaCents: DRIFT_CENTS }] });

      // Paid back by bank transfer: the charge corrected to its refund rows, then the task on it alone.
      await resolve("completed", tasks[0]!.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: DRIFT_CENTS });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await corrections()).toEqual([
        { category: "payment", entityId: CARD_TXN, metadata: expect.objectContaining({ refundedBeforeCents: CHARGE_CENTS, refundedAfterCents: CHARGE_CENTS - DRIFT_CENTS, manualRefundTaskId: tasks[0]!.id }) },
      ]);
      const handBackLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, postingKey: `handback:${tasks[0]!.id}` },
        select: { kind: true, amountCents: true },
      });
      expect(handBackLines).toEqual([{ kind: "BANK_REFUND", amountCents: -DRIFT_CENTS }]);
      expect(await taskRefundNotes()).toEqual([{ cents: DRIFT_CENTS, taskId: tasks[0]!.id }]);
      // The member's page counts the hand-back's REFUNDED event: the whole charge reads refunded.
      const page = await memberPage();
      expect(page).toContain("$200.00 was refunded on 1 Jul 2026.");
      expect(page).not.toContain("in touch");

      // #4147's census: confirmed now, and the completed task explains the rest.
      const after = await census("apply");
      expect(after.posted).toMatchObject({ kind: "POSTED" });
      expect(after.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(after.disagreements).toEqual([]);
      expect(after.integrity).toEqual([]);
    });

    it("an empty plan whose records drifted: nothing by card, the whole charge to check; marked paid back, the charge is corrected and the whole $200.00 posts its line and its Xero note, and the census agrees", async () => {
      await seed({ refundedCents: CHARGE_CENTS });
      const asked = stripeRefunds("make");

      await capacityRace();
      expect(asked).toEqual([]);
      const task = await checkTask();
      expect(task).toMatchObject({ status: "OPEN", amountCents: CHARGE_CENTS });
      expect(await memberPage()).toContain("The club will be in touch about the $200.00.");

      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED", amountCents: CHARGE_CENTS });
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: CARD_TXN }, select: { refundedAmountCents: true } })).toEqual({ refundedAmountCents: CHARGE_CENTS });
      expect(await corrections()).toEqual([
        { category: "payment", entityId: CARD_TXN, metadata: expect.objectContaining({ refundedBeforeCents: CHARGE_CENTS, refundedAfterCents: 0, recordedCardRefundCents: 0 }) },
      ]);
      expect(await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" }, select: { amountCents: true } })).toEqual([{ amountCents: -CHARGE_CENTS }]);
      expect(await taskRefundNotes()).toEqual([{ cents: CHARGE_CENTS, taskId: task.id }]);
      const page = await memberPage();
      expect(page).toContain("$200.00 was refunded on 1 Jul 2026.");
      expect(page).not.toContain("in touch");

      const after = await census("apply");
      expect(after.posted).toMatchObject({ kind: "POSTED" });
      expect(after.price).toMatchObject({ status: "AGREE", deltaCents: 0 });
      expect(after.disagreements).toEqual([]);
      expect(after.integrity).toEqual([]);
    });

    it("MUTATION (PR #4159 F2/F4): a later intent's charge captured on the payment, holding plenty, is never the task's: the corrected race charge takes it", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      stripeRefunds("make");
      await capacityRace();
      await lateCharge(50_000);

      await resolve("completed", (await checkTask()).id);
      expect(await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } })).toEqual([
        { id: CARD_TXN, refundedAmountCents: CHARGE_CENTS },
        { id: LATE_TXN, refundedAmountCents: 0 },
      ]);
    });

    it("the card refund still being sent: completion is refused, and nothing corrected, until the runner makes the race's refund", async () => {
      await seed({ refundedCents: DRIFT_CENTS });
      stripeRefunds("unreachable");

      expect((await capacityRace()).outcome).not.toBe("cancelled_refunded");
      const task = await checkTask();
      expect(task).toMatchObject({ status: "OPEN", amountCents: DRIFT_CENTS });

      await expect(resolve("completed", task.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/still being refunded|waiting to retry/) });
      expect(await checkTask()).toMatchObject({ status: "OPEN" });
      expect(await corrections()).toEqual([]);
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);

      // Its retry comes due and Stripe makes it; then the task can be marked.
      stripeRefunds("make");
      const raceRow = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: RACE_ROW_KEY } });
      await prisma.paymentRecoveryOperation.update({ where: { id: raceRow.id }, data: { nextRetryAt: new Date("2020-01-01T00:00:00.000Z") } });
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(raceRow.id, CLUB_FORMAT_TEST)).toBe("succeeded");

      await resolve("completed", task.id);
      expect(await checkTask()).toMatchObject({ status: "COMPLETED" });
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(1);
      expect(await corrections()).toHaveLength(1);
    });

    it("MUTATION: a charge made before the refund ledger started is never corrected - refused naming why, nothing written, the later charge untouched; dismissed, the page says the club closed it", async () => {
      await seed({ refundedCents: CHARGE_CENTS, chargeMadeAt: new Date("2026-05-01T00:00:00.000Z") });
      stripeRefunds("make");
      await capacityRace();
      await lateCharge(50_000);
      const task = await checkTask();

      await expect(resolve("completed", task.id)).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/^The payment's records show none of this card charge left to refund.*raise its refund credit note in Xero by hand.*the charge was made before the app kept a record of each card refund/),
      });
      expect(await checkTask()).toMatchObject({ status: "OPEN" });
      expect(await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, orderBy: { id: "asc" }, select: { id: true, refundedAmountCents: true } })).toEqual([
        { id: CARD_TXN, refundedAmountCents: CHARGE_CENTS },
        { id: LATE_TXN, refundedAmountCents: 0 },
      ]);
      expect(await corrections()).toEqual([]);
      expect(await prisma.bookingLedgerLine.count({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" } })).toBe(0);

      await resolve("dismissed", task.id, "Refunded in the Stripe dashboard on 2 July.");
      expect(await checkTask()).toMatchObject({ status: "DISMISSED" });
      expect(await taskRefundNotes()).toEqual([]);
      const page = await memberPage();
      expect(page).toContain("The club checked the $200.00 and closed it.");
      expect(page).not.toContain("in touch");
    });
  },
);
