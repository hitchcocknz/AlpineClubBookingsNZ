/**
 * Real-PostgreSQL pins for #4230 (`INV-PAY-124`, `INV-ADDPAY-021`): two kinds
 * of bank-transfer cash the inbound refunded-total recount
 * (`repairRefundedPaymentBusinessState`) was suspected of dropping, shown safe.
 *
 * - A group organiser's hand-back (#4042) moves no payment's refunded total.
 *   The group cancel already recorded each joiner's refund on the joiner's own
 *   payment, under that payment's own canonical note, so completing the
 *   organiser's task writes no payment row and leaves nothing for a recount to
 *   drop.
 * - The recount writes `Payment.refundedAmountCents` and never the charge rows.
 *   That split is deliberate: the paid cancel folds the difference into the
 *   rows later (#1491, `foldMirrorRefundIntoLedger`), and the rows are the
 *   detail the #4162 floor keeps, so a recount that rewrote them would erase
 *   the floor it is held to.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4230-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4230-member";
const OFFICER_ID = "race-4230-officer";
const LODGE_ID = "race-4230-lodge";
const ORGANISER_BOOKING_ID = "race-4230-organiser";
const JOINER_BOOKING_ID = "race-4230-joiner";
const ORGANISER_PAYMENT_ID = "race-4230-organiser-payment";
const JOINER_PAYMENT_ID = "race-4230-joiner-payment";
const TASK_ID = "race-4230-organiser-task";
const SETTLEMENT_ID = "race-4230-settlement";
const CANONICAL_NOTE = "cn-race-4230-canonical";

const BOOKING_IDS = [ORGANISER_BOOKING_ID, JOINER_BOOKING_ID];
const PAYMENT_IDS = [ORGANISER_PAYMENT_ID, JOINER_PAYMENT_ID];

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the inbound recount of a bank-transfer payment and the cash it was suspected of dropping - real PostgreSQL (#4230)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: BOOKING_IDS } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: PAYMENT_IDS } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: PAYMENT_IDS } } });
      await prisma.payment.deleteMany({ where: { id: { in: PAYMENT_IDS } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: { in: BOOKING_IDS } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer recount (#4230)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Hand", lastName: "Back", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4230 Lodge", slug: "race-4230" } });
      for (const id of BOOKING_IDS) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
            checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
            organiserSettled: id === JOINER_BOOKING_ID,
          },
        });
      }
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function paymentState(id: string) {
      return prisma.payment.findUniqueOrThrow({ where: { id }, select: { refundedAmountCents: true, status: true } });
    }

    async function linkCanonicalNote(paymentId: string, cents: number) {
      await prisma.payment.update({ where: { id: paymentId }, data: { xeroRefundCreditNoteId: CANONICAL_NOTE } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4230",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: cents, status: "PAID" },
        },
      });
    }

    /** The inbound reconcile of the canonical note, read from a fake Xero (no provider call). */
    async function reconcileCanonicalNote(totalDollars: number) {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      const note = {
        creditNoteID: CANONICAL_NOTE, creditNoteNumber: "CN-4230", status: "PAID",
        total: totalDollars, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4230" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await reconcileXeroCreditNote(CANONICAL_NOTE);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /** The refund-ledger divergence alerts raised while `run` executes (#1353, #4162 floors). */
    async function watchDivergenceAlerts(run: () => Promise<unknown>): Promise<string[]> {
      const alerting = await import("@/lib/xero-error-alert");
      const spy = vi.spyOn(alerting, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      try {
        await run();
        return spy.mock.calls
          .map(([input]) => input as { errorType: string; operation: string })
          .filter((input) => input.errorType === "refund-ledger-divergence")
          .map((input) => input.operation);
      } finally {
        spy.mockRestore();
      }
    }

    it("a group organiser's hand-back moves no payment's refunded total, and a joiner's canonical-note recount keeps the joiner's refund (#4042)", async () => {
      // What the organiser's Internet Banking group cancel wrote for the joiner
      // (`group-cancel.ts`): the child's refund mirror, with no charge rows, and
      // the child's own refund note. And the organiser's own bank-transfer payment.
      await prisma.payment.create({
        data: {
          id: JOINER_PAYMENT_ID, bookingId: JOINER_BOOKING_ID, amountCents: 10_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 8_000, xeroInvoiceId: "inv-race-4230-joiner",
        },
      });
      await linkCanonicalNote(JOINER_PAYMENT_ID, 8_000);
      await prisma.payment.create({
        data: { id: ORGANISER_PAYMENT_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: "inv-race-4230-organiser" },
      });
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 8_000, raisedAmountCents: 8_000, kind: "CANCELLED_BOOKING_HAND_BACK",
          occurrenceKey: `group-organiser-hand-back:${SETTLEMENT_ID}`, reason: "race 4230 organiser hand-back",
          reviewContext: { groupOrganiserHandBack: { settlementId: SETTLEMENT_ID, shares: [{ bookingId: JOINER_BOOKING_ID, name: "Joiner", cents: 8_000 }] } },
        },
      });

      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        {
          taskId: TASK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID,
          confirmedAmountCents: 8_000, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
        },
        CLUB_FORMAT_TEST,
      );

      // The completion wrote no payment row and queued no note: there is no cash of its own to drop.
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: TASK_ID }, select: { status: true, paymentId: true } })).toEqual({ status: "COMPLETED", paymentId: null });
      expect(await paymentState(JOINER_PAYMENT_ID)).toEqual({ refundedAmountCents: 8_000, status: "PARTIALLY_REFUNDED" });
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "Payment", localId: { in: PAYMENT_IDS } } })).toBe(0);

      // The joiner's refund is its own canonical note's, so the recount keeps it and alerts nothing.
      const alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(80));
      expect(await paymentState(JOINER_PAYMENT_ID)).toEqual({ refundedAmountCents: 8_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);
    });

    it("the recount writes the payment's refunded total and never its charge rows: the rows stay the #4162 floor's detail (#1491)", async () => {
      await prisma.payment.create({
        data: {
          id: ORGANISER_PAYMENT_ID, bookingId: ORGANISER_BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 10_000, xeroInvoiceId: "inv-race-4230-organiser",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4230-txn", paymentId: ORGANISER_PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000,
          refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED",
        },
      });
      await linkCanonicalNote(ORGANISER_PAYMENT_ID, 10_000);
      const rows = () => prisma.paymentTransaction.findMany({ where: { paymentId: ORGANISER_PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });

      // Xero shows the note raised to $150: the recount follows it on the payment only.
      await reconcileCanonicalNote(150);
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      expect(await rows()).toEqual([{ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" }]);

      // Back to $100: the total comes down to Xero's figure, which the rows still hold, so no alert.
      let alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(100));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([]);

      // Below the rows' $100: kept at the rows and alerted. Had the recount
      // written the rows, the floor would have had nothing to keep.
      alerts = await watchDivergenceAlerts(() => reconcileCanonicalNote(60));
      expect(await paymentState(ORGANISER_PAYMENT_ID)).toEqual({ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" });
      expect(alerts).toEqual([`inbound-credit-note-repair:${CANONICAL_NOTE}`]);
      expect(await rows()).toEqual([{ refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" }]);
    });
  },
);
