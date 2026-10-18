/**
 * Real-PostgreSQL proof for #4219: when a credit note funding a booking's
 * applied credit was spent in Xero outside the app, the allocation worker brings
 * the credit ledger into line with Xero by itself - the lot is written down, the
 * booking's applied credit is released, the failed allocation is closed - and
 * writes nothing to Xero.
 *
 * Xero is a fake provider at the client seam (`getAuthenticatedXeroClient`,
 * `callXeroApi`): it keeps each credit note's allocations (including the outside
 * spend), honours idempotency keys, and REFUSES an allocation beyond a note's
 * remaining credit with Xero's own wording. Everything else is real: the ledger,
 * the slices, the allocation engine, the lock protocol and the audit log. The
 * fake is switched on only inside this describe.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-note-spent-outside-app.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4219-member";
const LODGE_ID = "race-4219-lodge";
const BOOKING_ID = "race-4219-booking";
const SECOND_BOOKING_ID = "race-4219-booking-two";
const GUEST_ID = "race-4219-guest";
const PAYMENT_ID = "race-4219-payment";
const SECOND_PAYMENT_ID = "race-4219-payment-two";
const XERO_INVOICE_ID = "race-4219-xero-invoice";
const SECOND_XERO_INVOICE_ID = "race-4219-xero-invoice-two";
const SPENT_NOTE_ID = "race-4219-note-spent";
const HEALTHY_NOTE_ID = "race-4219-note-healthy";
const SPENT_LOT_ID = "race-4219-lot-spent";
const HEALTHY_LOT_ID = "race-4219-lot-healthy";
const OUTSIDE_INVOICE_ID = "race-4219-outside-invoice";

const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const CREDIT_CENTS = 5_250;
/** Older than the healthy lot, so the planner reaches for it first (`INV-PAY-127`). */
const SPENT_LOT_AT = new Date("2026-05-01T00:00:00.000Z");
const HEALTHY_LOT_AT = new Date("2026-06-01T00:00:00.000Z");

/** The fake Xero: each note's total and allocations, and what the app tried. */
const fakeXero = vi.hoisted(() => {
  const XERO_REFUSAL_TEXT =
    "Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note";
  type Allocation = { allocationID: string; invoiceID: string; amountCents: number };
  const state = {
    on: false,
    seq: 0,
    notes: new Map<string, { totalCents: number; allocations: Allocation[] }>(),
    seenKeys: new Map<string, unknown>(),
    acceptedAllocations: 0,
    refusedAllocations: 0,
    deallocations: 0,
  };
  const remainingCents = (noteId: string) => {
    const note = state.notes.get(noteId);
    return note ? note.totalCents - note.allocations.reduce((sum, a) => sum + a.amountCents, 0) : 0;
  };
  const noteBody = (creditNoteID: string) => {
    const note = state.notes.get(creditNoteID);
    const remaining = remainingCents(creditNoteID);
    return {
      creditNotes: [
        {
          creditNoteID,
          status: remaining > 0 ? "AUTHORISED" : "PAID",
          total: (note?.totalCents ?? 0) / 100,
          remainingCredit: remaining / 100,
          allocations: (note?.allocations ?? []).map((a) => ({
            allocationID: a.allocationID,
            invoice: { invoiceID: a.invoiceID },
            amount: a.amountCents / 100,
          })),
        },
      ],
    };
  };
  const accountingApi = {
    async createCreditNoteAllocation(
      _tenant: string,
      creditNoteID: string,
      body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> },
      _summarize: unknown,
      idempotencyKey?: string,
    ) {
      if (idempotencyKey && state.seenKeys.has(idempotencyKey)) return { body: state.seenKeys.get(idempotencyKey) };
      const note = state.notes.get(creditNoteID);
      if (!note) throw new Error(`fake Xero: no credit note ${creditNoteID}`);
      for (const { invoice, amount } of body.allocations) {
        const cents = Math.round(amount * 100);
        if (cents > remainingCents(creditNoteID)) {
          state.refusedAllocations += 1;
          throw new Error(XERO_REFUSAL_TEXT);
        }
        note.allocations.push({ allocationID: `race-4219-allocation-${(state.seq += 1)}`, invoiceID: invoice.invoiceID, amountCents: cents });
        state.acceptedAllocations += 1;
      }
      const response = noteBody(creditNoteID);
      if (idempotencyKey) state.seenKeys.set(idempotencyKey, response);
      return { body: response };
    },
    async getCreditNote(_tenant: string, creditNoteID: string) {
      return { body: noteBody(creditNoteID) };
    },
    async deleteCreditNoteAllocations() {
      state.deallocations += 1;
      return { body: {} };
    },
  };
  return { state, remainingCents, client: { accountingApi } };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: ((...args: Parameters<typeof actual.getAuthenticatedXeroClient>) =>
      fakeXero.state.on
        ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-4219-tenant" })
        : actual.getAuthenticatedXeroClient(...args)) as typeof actual.getAuthenticatedXeroClient,
    callXeroApi: ((fn: () => Promise<unknown>, options: Parameters<typeof actual.callXeroApi>[1]) =>
      fakeXero.state.on ? fn() : actual.callXeroApi(fn, options)) as typeof actual.callXeroApi,
  };
});

function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) throw new Error("The race DB must be loopback-only.");
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) throw new Error("The race DB name must carry 'concurrency_race_1881'.");
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let credit: typeof import("@/lib/member-credit");
let ledgerState: typeof import("@/lib/xero-applied-credit-ledger-state");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;

(RUN ? describe : describe.skip)(
  "#4219: a credit note spent in Xero outside the app converges the credit ledger - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    const bookingIds = [BOOKING_ID, SECOND_BOOKING_ID];
    const paymentIds = [PAYMENT_ID, SECOND_PAYMENT_ID];

    async function deleteFixtures() {
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: { in: bookingIds } }, select: { id: true } });
      const localIds = [...paymentIds, ...bookingIds, ...slices.map((slice) => slice.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { appliedToBookingId: { in: bookingIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER_ID } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { actorMemberId: MEMBER_ID }, { targetId: { in: bookingIds } }] } });
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: { in: bookingIds } } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function createBooking(bookingId: string, paymentId: string, invoiceId: string, creditCents: number) {
      await prisma.booking.create({
        data: { id: bookingId, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      const guestId = bookingId === BOOKING_ID ? GUEST_ID : `${GUEST_ID}-two`;
      await prisma.bookingGuest.create({
        data: { id: guestId, bookingId, firstName: "Credit", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingGuestNight.createMany({
        data: NIGHTS.map((stayDate) => ({ bookingGuestId: guestId, stayDate, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" as const })),
      });
      for (const [index, night] of NIGHTS.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: PRICE_CENTS / 2, amountCents: PRICE_CENTS / 2,
          bookingGuestId: guestId, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Credit Guest"], anchorKind: "CONFIRMATION", anchorId: bookingId, narration: "race 4219 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4219-confirm-${bookingId}-${index}`,
        } });
      }
      await prisma.payment.create({
        data: { id: paymentId, bookingId, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED", creditAppliedCents: creditCents, source: "STRIPE", xeroInvoiceId: invoiceId },
      });
      await prisma.paymentTransaction.create({
        data: { paymentId, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: `race-4219-pi-${bookingId}`, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED" },
      });
    }

    /**
     * The shape #4219 is about: a $52.50 cancellation credit (an older lot, its
     * note in Xero) that the app applied to a booking, whose note was meanwhile
     * used in Xero outside the app - an allocation to some other invoice of
     * `outsideSpentCents`. A second, healthy $52.50 lot and booking let the
     * tests prove the written-down lot is not planned again.
     */
    async function seed({ outsideSpentCents = CREDIT_CENTS }: { outsideSpentCents?: number } = {}) {
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-4219@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4219 Lodge", slug: "race-4219" } });
      await prisma.memberCredit.create({
        data: { id: SPENT_LOT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: "race 4219 spent lot", xeroCreditNoteId: SPENT_NOTE_ID, createdAt: SPENT_LOT_AT },
      });
      await createBooking(BOOKING_ID, PAYMENT_ID, XERO_INVOICE_ID, CREDIT_CENTS);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, CREDIT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));

      fakeXero.state.on = true;
      fakeXero.state.seq = 0;
      fakeXero.state.acceptedAllocations = 0;
      fakeXero.state.refusedAllocations = 0;
      fakeXero.state.deallocations = 0;
      fakeXero.state.seenKeys.clear();
      fakeXero.state.notes = new Map([
        [SPENT_NOTE_ID, { totalCents: CREDIT_CENTS, allocations: outsideSpentCents > 0 ? [{ allocationID: "race-4219-outside", invoiceID: OUTSIDE_INVOICE_ID, amountCents: outsideSpentCents }] : [] }],
        [HEALTHY_NOTE_ID, { totalCents: CREDIT_CENTS, allocations: [] }],
      ]);
      expect(await credit.getMemberCreditBalance(MEMBER_ID)).toBe(0);
    }

    /** A second booking with its own $52.50 of credit, planned after the first converges. */
    async function addHealthyLotAndSecondBooking() {
      await prisma.memberCredit.create({
        data: { id: HEALTHY_LOT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: "race 4219 healthy lot", xeroCreditNoteId: HEALTHY_NOTE_ID, createdAt: HEALTHY_LOT_AT },
      });
      await createBooking(SECOND_BOOKING_ID, SECOND_PAYMENT_ID, SECOND_XERO_INVOICE_ID, CREDIT_CENTS);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, CREDIT_CENTS, SECOND_BOOKING_ID, tx, CLUB_FORMAT_TEST));
    }

    async function runEngine(bookingId = BOOKING_ID) {
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(bookingId);
    }
    const balance = () => credit.getMemberCreditBalance(MEMBER_ID);
    const applied = (bookingId = BOOKING_ID) => credit.deriveBookingAppliedCreditCents(bookingId);
    const slices = (bookingId = BOOKING_ID) => prisma.memberCreditNoteAllocation.findMany({ where: { appliedToBookingId: bookingId } });
    const writeDowns = () => prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID, type: "ADMIN_ADJUSTMENT", amountCents: { lt: 0 } } });
    const convergedAudits = () => prisma.auditLog.count({ where: { action: "xero.credit_note.spent_outside_app_converged", targetId: BOOKING_ID } });

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      credit = await import("@/lib/member-credit");
      ledgerState = await import("@/lib/xero-applied-credit-ledger-state");
    }, 60_000);

    afterEach(() => {
      fakeXero.state.on = false;
    });

    afterAll(async () => {
      fakeXero.state.on = false;
      try {
        if (typeof prisma !== "undefined") {
          try {
            await deleteFixtures();
          } finally {
            await prisma.$disconnect().catch(() => {});
          }
        }
      } finally {
        harnessRole?.restore();
      }
    });

    it("the allocation worker converges a fully spent note: ledger and Xero agree, nothing is written to Xero, the failure is closed, and a second run does nothing", async () => {
      await seed();

      await runEngine();

      // Xero was refused once and given nothing; the offset stands as the treasurer left it.
      expect(fakeXero.state.refusedAllocations).toBe(1);
      expect(fakeXero.state.acceptedAllocations).toBe(0);
      expect(fakeXero.state.deallocations).toBe(0);
      expect(fakeXero.remainingCents(SPENT_NOTE_ID)).toBe(0);
      // The member's credit is the same (nothing moved); the booking no longer counts the credit as applied.
      expect(await balance()).toBe(0);
      expect(await applied()).toBe(0);
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).creditAppliedCents).toBe(0);
      expect(await slices()).toHaveLength(0);
      const down = await writeDowns();
      expect(down.map((row) => [row.amountCents, row.xeroCreditNoteId])).toEqual([[-CREDIT_CENTS, SPENT_NOTE_ID]]);
      // The failed allocation left the Active list through the resolution fields; one audit row.
      const failed = await prisma.xeroSyncOperation.findMany({ where: { entityType: "ALLOCATION", status: "FAILED" } });
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((operation) => operation.manuallyResolvedAt !== null)).toBe(true);
      expect(failed.every((operation) => operation.lastErrorCode === "CREDIT_NOTE_SPENT_OUTSIDE_APP")).toBe(true);
      expect(await convergedAudits()).toBe(1);

      // Repeating it changes nothing.
      const rowsBefore = await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } });
      await runEngine();
      expect(await prisma.memberCredit.count({ where: { memberId: MEMBER_ID } })).toBe(rowsBefore);
      expect(await convergedAudits()).toBe(1);
      expect(fakeXero.state.refusedAllocations).toBe(1);
    });

    it("a written-down lot is not planned again: the next booking's credit comes from the healthy lot", async () => {
      await seed();
      await runEngine();
      await addHealthyLotAndSecondBooking();

      await runEngine(SECOND_BOOKING_ID);

      expect(fakeXero.state.refusedAllocations).toBe(1);
      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(HEALTHY_NOTE_ID)).toBe(0);
      expect((await slices(SECOND_BOOKING_ID)).map((slice) => [slice.memberCreditId, slice.amountCents])).toEqual([[HEALTHY_LOT_ID, CREDIT_CENTS]]);
      expect(await ledgerState.unallocatedAppliedCents(SECOND_BOOKING_ID)).toBe(0);
    });

    it("a partly spent note keeps the rest: the missing part is converged and the remainder allocates", async () => {
      await seed({ outsideSpentCents: 2_000 });

      await runEngine();

      expect(fakeXero.state.acceptedAllocations).toBe(1);
      expect(fakeXero.remainingCents(SPENT_NOTE_ID)).toBe(0);
      expect((await writeDowns()).map((row) => row.amountCents)).toEqual([-2_000]);
      expect(await applied()).toBe(CREDIT_CENTS - 2_000);
      expect((await slices()).map((slice) => slice.amountCents)).toEqual([CREDIT_CENTS - 2_000]);
      expect(await ledgerState.unallocatedAppliedCents(BOOKING_ID)).toBe(0);
      expect(await balance()).toBe(0);
    });

    it("two concurrent runs write one set of rows", async () => {
      await seed();

      const settled = await Promise.allSettled([runEngine(), runEngine()]);

      // Neither run fails: the one that lost the race finds nothing left to allocate.
      expect(settled.map((run) => run.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await writeDowns()).toHaveLength(1);
      expect(await prisma.memberCredit.count({ where: { appliedToBookingId: BOOKING_ID, type: "BOOKING_APPLIED", amountCents: { gt: 0 } } })).toBe(1);
      expect(await convergedAudits()).toBe(1);
      expect(await applied()).toBe(0);
      expect(await balance()).toBe(0);
    });

    it("converges nothing when Xero shows the note has its credit (the offset was reversed)", async () => {
      await seed({ outsideSpentCents: 0 });
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, remainingCents: CREDIT_CENTS });

      expect(result).toEqual({ converged: false, reason: "nothing-missing" });
      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
      expect(await slices()).toHaveLength(1);
    });

    it("writes nothing when the slice is already held by Xero", async () => {
      await seed();
      const slice = await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "MemberCreditNoteAllocation", localId: slice.id, xeroObjectType: "ALLOCATION", xeroObjectId: "race-4219-held",
          role: "APPLIED_CREDIT_ALLOCATION", active: true,
        },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, remainingCents: 0 });

      expect(result).toEqual({ converged: false, reason: "slice-already-in-xero" });
      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
    });

    it("waits behind an unfinished deallocation of the booking's applied credit and writes nothing", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "ALLOCATION", operationType: "UPDATE", localModel: "Payment", localId: PAYMENT_ID, status: "FAILED",
          queueType: "APPLIED_CREDIT_DEALLOCATION", idempotencyKey: "race-4219-deallocation", correlationKey: "race-4219-deallocation",
          requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION", bookingId: BOOKING_ID },
        },
      });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      await expect(
        convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, remainingCents: 0 }),
      ).rejects.toThrow(/deallocation/i);

      expect(await writeDowns()).toHaveLength(0);
      expect(await applied()).toBe(CREDIT_CENTS);
      expect(await slices()).toHaveLength(1);
    });

    it("leaves a cancelled booking to its cancel", async () => {
      await seed();
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: SPENT_LOT_ID, xeroCreditNoteId: SPENT_NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: CREDIT_CENTS },
      });
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { status: "PENDING", amountCents: 0 } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      const { convergeCreditNoteSpentOutsideApp } = await import("@/lib/xero-applied-credit-spent-outside-app");

      const result = await convergeCreditNoteSpentOutsideApp({ bookingId: BOOKING_ID, creditNoteId: SPENT_NOTE_ID, remainingCents: 0 });

      expect(result).toEqual({ converged: false, reason: "settled-by-cancel" });
      expect(await writeDowns()).toHaveLength(0);
    });
  },
);

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("#4219: the harness puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
    expect(harnessRole, "the harness declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(harnessRole!.before);
  });
});
