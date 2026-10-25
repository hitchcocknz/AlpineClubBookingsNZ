/**
 * Real-PostgreSQL proof for #4220 (lane a): the early warning for a credit note spent in Xero outside
 * the app. The reading Xero sent is kept with the note's link at ingest; the warning is derived from it
 * at read time by the same comparator the inbound mirror (#4270) uses. Nothing is written to the ledger,
 * no stored flag, no Xero call outside the ingest's own single read.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-note-spent-outside-early-warning.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ENVIRONMENT_ROLE_ENV_VAR } from "@/lib/environment-role-declaration";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4220-member";
const LODGE_ID = "race-4220-lodge";
const BOOKING_ID = "race-4220-booking";
const GUEST_ID = "race-4220-guest";
const PAYMENT_ID = "race-4220-payment";
const NOTE_ID = "race-4220-note";
const LOT_ID = "race-4220-lot";
const OUTSIDE_INVOICE_ID = "race-4220-outside-invoice";

const NIGHTS = [new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const PRICE_CENTS = 20_000;
const LOT_CENTS = 5_250;
/** The suite's frozen day: a note "changed ten minutes ago" is settled and one changed a minute ago is not. */
const NOW = new Date("2026-07-01T00:00:00.000Z");
const SETTLED_AT = new Date(NOW.getTime() - 10 * 60 * 1000);
const FRESH_AT = new Date(NOW.getTime() - 60 * 1000);

/** Only the one credit-note read the ingest makes. */
const fakeXero = vi.hoisted(() => {
  const state = {
    on: false,
    note: null as null | { status?: string; allocations: Array<{ invoiceID: string; amountCents: number }>; updatedAt: Date },
    reads: [] as string[],
  };
  const accountingApi = {
    async getCreditNote(_tenant: string, creditNoteID: string) {
      state.reads.push(creditNoteID);
      const note = state.note!;
      const spent = note.allocations.reduce((sum, a) => sum + a.amountCents, 0);
      return {
        body: {
          creditNotes: [
            {
              creditNoteID,
              status: note.status ?? (spent >= 5_250 ? "PAID" : "AUTHORISED"),
              total: 52.5,
              remainingCredit: (5_250 - spent) / 100,
              updatedDateUTC: note.updatedAt,
              payments: [],
              allocations: note.allocations.map((a, index) => ({ allocationID: `${creditNoteID}-${index}`, invoice: { invoiceID: a.invoiceID }, amount: a.amountCents / 100 })),
            },
          ],
        },
      };
    },
  };
  return { state, client: { accountingApi } };
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
let flag: typeof import("@/lib/xero-credit-note-spent-outside-flag");
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let installedSpies: Array<{ mockRestore: () => void }> = [];

(RUN ? describe : describe.skip)(
  "#4220: the early warning for a credit note spent in Xero outside the app - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const slices = await prisma.memberCreditNoteAllocation.findMany({ where: { memberCredit: { memberId: MEMBER_ID } }, select: { id: true } });
      const localIds = [PAYMENT_ID, BOOKING_ID, ...slices.map((slice) => slice.id)];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: { in: [NOTE_ID, OUTSIDE_INVOICE_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { memberCredit: { memberId: MEMBER_ID } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: MEMBER_ID }, { subjectMemberId: MEMBER_ID }, { targetId: { in: [BOOKING_ID, LOT_ID] } }] } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function createBooking(creditCents: number) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      await prisma.bookingGuest.create({
        data: { id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Credit", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingGuestNight.createMany({
        data: NIGHTS.map((stayDate) => ({ bookingGuestId: GUEST_ID, stayDate, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" as const })),
      });
      for (const [index, night] of NIGHTS.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: PRICE_CENTS / 2, amountCents: PRICE_CENTS / 2,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Credit Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 4220 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4220-confirm-${index}`,
        } });
      }
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED", creditAppliedCents: creditCents, source: "STRIPE", xeroInvoiceId: "race-4220-xero-invoice" },
      });
      await prisma.paymentTransaction.create({
        data: { paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: "race-4220-pi", amountCents: PRICE_CENTS - creditCents, status: "SUCCEEDED" },
      });
    }

    /** A $52.50 lot funded by a Xero note and wholly drawn onto a booking, with the note's link and nothing read yet. */
    async function seed() {
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: "race-4220@example.invalid", passwordHash: "x", firstName: "Credit", lastName: "Payer", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4220 Lodge", slug: "race-4220" } });
      await prisma.memberCredit.create({
        data: { id: LOT_ID, memberId: MEMBER_ID, amountCents: LOT_CENTS, type: "CANCELLATION_REFUND", description: "race 4220 lot", xeroCreditNoteId: NOTE_ID, createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      await createBooking(LOT_CENTS);
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, LOT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      await prisma.memberCreditNoteAllocation.create({
        data: { memberCreditId: LOT_ID, xeroCreditNoteId: NOTE_ID, appliedToBookingId: BOOKING_ID, amountCents: LOT_CENTS },
      });
      // The link the app wrote when it raised the note: outbound figures the ingest must merge over, not destroy.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "ACCOUNT_CREDIT_NOTE", active: true,
          metadata: { amountCents: LOT_CENTS, watermarkCents: LOT_CENTS },
        },
      });
      fakeXero.state.note = null;
      fakeXero.state.reads = [];
    }

    async function ingest(note: { status?: string; allocations?: Array<{ invoiceID: string; amountCents: number }>; updatedAt?: Date }) {
      fakeXero.state.on = true;
      fakeXero.state.note = { status: note.status, allocations: note.allocations ?? [], updatedAt: note.updatedAt ?? SETTLED_AT };
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await reconcileXeroCreditNote(NOTE_ID);
      fakeXero.state.on = false;
    }
    const spentAll = { allocations: [{ invoiceID: OUTSIDE_INVOICE_ID, amountCents: LOT_CENTS }] };
    const flagged = () => flag.findCreditNotesSpentOutsideApp(prisma);
    const ledgerRows = () => prisma.memberCredit.count({ where: { memberId: MEMBER_ID } });
    const linkMetadata = async () => (await prisma.xeroObjectLink.findFirst({ where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, active: true } }))?.metadata as Record<string, any> | null;

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      credit = await import("@/lib/member-credit");
      flag = await import("@/lib/xero-credit-note-spent-outside-flag");
      const xeroApi = await import("@/lib/xero-api-client");
      const realGetClient = xeroApi.getAuthenticatedXeroClient;
      const realCall = xeroApi.callXeroApi;
      installedSpies = [
        vi.spyOn(xeroApi, "getAuthenticatedXeroClient").mockImplementation(((...args: Parameters<typeof realGetClient>) =>
          fakeXero.state.on ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-4220-tenant" }) : realGetClient(...args)) as typeof realGetClient),
        vi.spyOn(xeroApi, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>, options: Parameters<typeof realCall>[1]) =>
          fakeXero.state.on ? fn() : realCall(fn, options)) as typeof realCall),
      ];
    }, 60_000);

    afterEach(() => {
      fakeXero.state.on = false;
    });

    afterAll(async () => {
      fakeXero.state.on = false;
      for (const installed of installedSpies) installed.mockRestore();
      installedSpies = [];
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

    it("keeps the reading with the note's link at ingest, merged over the outbound figures, and flags the note from it", async () => {
      await seed();
      expect(await flagged()).toEqual([]);

      await ingest(spentAll);

      const metadata = await linkMetadata();
      expect(metadata).toMatchObject({ amountCents: LOT_CENTS, watermarkCents: LOT_CENTS });
      expect(metadata!.spendEvidence).toMatchObject({ status: "PAID", totalCents: LOT_CENTS, remainingCents: 0, allocations: [{ invoiceId: OUTSIDE_INVOICE_ID, cents: LOT_CENTS }] });
      expect(await flagged()).toEqual([
        expect.objectContaining({ creditNoteId: NOTE_ID, memberId: MEMBER_ID, lotId: LOT_ID, outsideSpendCents: LOT_CENTS, leftForAllocationCents: LOT_CENTS, bookingIds: [BOOKING_ID] }),
      ]);
    });

    it("counts it on the Xero health summary, and a different booking's check does not see it", async () => {
      await seed();
      await ingest(spentAll);

      const { getXeroAdminHealthSnapshot } = await import("@/lib/xero-admin-health");
      expect((await getXeroAdminHealthSnapshot()).creditNotesSpentOutsideApp).toEqual({ count: 1 });
      expect(await flag.findCreditNotesSpentOutsideApp(prisma, { bookingIds: ["race-4220-other-booking"] })).toEqual([]);
      expect(await flag.findCreditNotesSpentOutsideApp(prisma, { bookingIds: [BOOKING_ID] })).toHaveLength(1);
    });

    it("writes nothing and makes no Xero call when asked, however often", async () => {
      await seed();
      await ingest(spentAll);
      const rowsBefore = await ledgerRows();
      const metadataBefore = await linkMetadata();
      const audits = await prisma.auditLog.count();
      const operations = await prisma.xeroSyncOperation.count();
      fakeXero.state.reads = [];

      await flagged();
      await flagged();

      expect(await ledgerRows()).toBe(rowsBefore);
      expect(await linkMetadata()).toEqual(metadataBefore);
      expect(await prisma.auditLog.count()).toBe(audits);
      expect(await prisma.xeroSyncOperation.count()).toBe(operations);
      expect(fakeXero.state.reads).toEqual([]);
    });

    it("clears when Xero later shows the spend reversed, and flags nothing for a note not spent", async () => {
      await seed();
      await ingest({ allocations: [] });
      expect(await flagged()).toEqual([]);

      await ingest(spentAll);
      expect(await flagged()).toHaveLength(1);

      await ingest({ allocations: [] });
      expect(await flagged()).toEqual([]);
    });

    it("flags nothing for a note changed a moment ago, until it has settled", async () => {
      await seed();
      await ingest({ ...spentAll, updatedAt: FRESH_AT });
      expect(await flagged()).toEqual([]);

      await ingest({ ...spentAll, updatedAt: SETTLED_AT });
      expect(await flagged()).toHaveLength(1);
    });

    it("flags nothing from a link that has been deactivated", async () => {
      await seed();
      await ingest(spentAll);
      expect(await flagged()).toHaveLength(1);

      await prisma.xeroObjectLink.updateMany({ where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID }, data: { active: false } });

      expect(await flagged()).toEqual([]);
    });

    it("flags nothing for a voided note", async () => {
      await seed();
      await ingest({ ...spentAll, status: "VOIDED" });
      expect(await flagged()).toEqual([]);
    });

    it("flags nothing when the note funds a second lot", async () => {
      await seed();
      await prisma.memberCredit.create({
        data: { id: `${LOT_ID}-two`, memberId: MEMBER_ID, amountCents: 1_000, type: "CANCELLATION_REFUND", description: "race 4220 second lot", xeroCreditNoteId: NOTE_ID, createdAt: new Date("2026-05-02T00:00:00.000Z") },
      });
      await ingest(spentAll);
      expect(await flagged()).toEqual([]);
    });
  },
);

// The role declared above is put back, so no later suite inherits it.
(RUN ? describe : describe.skip)("#4220: the harness puts the environment role back", () => {
  it("leaves APP_ENVIRONMENT_ROLE as it found it", () => {
    expect(harnessRole, "the harness declared its environment role").toBeDefined();
    expect(process.env[ENVIRONMENT_ROLE_ENV_VAR]).toBe(harnessRole!.before);
  });
});
