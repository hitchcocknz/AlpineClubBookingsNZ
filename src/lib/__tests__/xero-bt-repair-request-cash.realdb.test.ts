/**
 * Real-PostgreSQL proof of #4215 (`INV-PAY-118`, `INV-ADDPAY-041`): on a
 * bank-transfer payment, the inbound Xero repair that rebuilds the refunded
 * total from the payment's notes keeps the cash a refund request paid back.
 *
 * The request is paid back through the REAL task completion, which moves the
 * refunded total and queues the request's own note
 * (`REFUND_REQUEST_CREDIT_NOTE`). The cancellation's canonical note is then
 * reconciled inbound with Xero faked. Before #4215 the rebuild read only the
 * canonical, account-credit and modification notes, so the request's cash fell
 * out of the total and the payment read as holding money it had paid back.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4215-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4215-member";
const OFFICER_ID = "race-4215-officer";
const LODGE_ID = "race-4215-lodge";
const BOOKING_ID = "race-4215-booking";
const PAYMENT_ID = "race-4215-payment";
const TASK_ID = "race-4215-task";
const REQUEST_ID = "race-4215-request";
const CANONICAL_NOTE = "cn-race-4215-canonical";
const REQUEST_NOTE = "cn-race-4215-request";
const INVOICE_ID = "inv-race-4215";

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeRequestCashRepairRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-request cash repair proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-request cash repair proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-request cash repair proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-request cash repair proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "the inbound repair of a bank-transfer payment's canonical refund note keeps a refund request's paid-back cash - real PostgreSQL (#4215)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRequestCashRepairRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Request", lastName: "Cash", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4215 Lodge", slug: "race-4215" } });
      // A refund request exists only on a cancelled booking.
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
    }, 60_000);

    /**
     * A $200 bank transfer whose cancellation refunded $100 under the
     * payment's one canonical note, and an approved refund request's $50
     * hand-back, then paid back through the REAL completion.
     */
    beforeEach(async () => {
      await clearRun();
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED",
          refundedAmountCents: 10_000, xeroInvoiceId: INVOICE_ID, xeroRefundCreditNoteId: CANONICAL_NOTE,
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: "race-4215-txn", paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 20_000,
          refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED",
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: CANONICAL_NOTE, xeroObjectNumber: "CN-4215",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: 10_000, status: "PAID" },
        },
      });
      await prisma.manualRefundTask.create({
        data: {
          id: TASK_ID, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 5_000, raisedAmountCents: 5_000,
          kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `refund-request-hand-back:${REQUEST_ID}`, reason: "race 4215 approved refund request",
        },
      });

      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await resolveManualRefundTask(
        {
          taskId: TASK_ID, resolution: "completed", note: null, actingMemberId: OFFICER_ID,
          confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null,
        },
        CLUB_FORMAT_TEST,
      );
      // The completion moved the refunded total and queued the request's own note.
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      const queued = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "Payment", localId: PAYMENT_ID, entityType: "CREDIT_NOTE" },
        select: { requestPayload: true },
      });
      expect(queued.map((row) => (row.requestPayload as Record<string, unknown>).refundRequestId)).toEqual([REQUEST_ID]);
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function paymentState() {
      return prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });
    }

    /** The outbox raised the request's note: its link, as the completion writes it. */
    async function linkRequestNote(status: string) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: REQUEST_NOTE, xeroObjectNumber: "CN-4215-R",
          role: "REFUND_REQUEST_CREDIT_NOTE", active: true, metadata: { amountCents: 5_000, refundRequestId: REQUEST_ID, status },
        },
      });
    }

    /** The inbound reconcile of `note`, read from a fake Xero (no provider call). */
    async function reconcileFromXero(note: Record<string, unknown>) {
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4215" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await reconcileXeroCreditNote(String(note.creditNoteID));
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    const canonicalNote = (status: string) => ({
      creditNoteID: CANONICAL_NOTE, creditNoteNumber: "CN-4215", status,
      total: 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
    });

    it("a canonical-note reconcile keeps the request's $50 beside the note's $100, and only a paid-back request counts", async () => {
      await linkRequestNote("PAID");
      // A second request still awaiting payment, and a third dismissed: no cash moved for either.
      for (const [suffix, status] of [["open", "OPEN"], ["dismissed", "DISMISSED"]] as const) {
        await prisma.manualRefundTask.create({
          data: {
            id: `${TASK_ID}-${suffix}`, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, amountCents: 2_000, raisedAmountCents: 2_000, status,
            kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `refund-request-hand-back:${REQUEST_ID}-${suffix}`, reason: "race 4215 other request",
            ...(status === "DISMISSED" ? { note: "race 4215 dismissed", completedAt: new Date("2026-06-01T00:00:00.000Z"), completedByMemberId: OFFICER_ID } : {}),
          },
        });
      }

      const result = await reconcileFromXero(canonicalNote("PAID"));

      // Before #4215: { refundedAmountCents: 10_000 } - the request's cash dropped out.
      expect(result.matchedRefundedPayments).toBe(1);
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
      // A redelivery moves nothing.
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });

    it("keeps it while the request's note is still queued, and after Xero voids it (#4195: a request's void moves no refunded total)", async () => {
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });

      await linkRequestNote("PAID");
      await reconcileFromXero({
        creditNoteID: REQUEST_NOTE, creditNoteNumber: "CN-4215-R", status: "VOIDED",
        total: 50, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      });
      await reconcileFromXero(canonicalNote("PAID"));
      expect(await paymentState()).toEqual({ refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" });
    });

    it("the canonical note voided: its $100 goes (INV-ADDPAY-041), the request's $50 stays - never attributed to the canonical note", async () => {
      await linkRequestNote("PAID");

      await reconcileFromXero(canonicalNote("VOIDED"));

      expect(await paymentState()).toEqual({ refundedAmountCents: 5_000, status: "PARTIALLY_REFUNDED" });
    });
  },
);
