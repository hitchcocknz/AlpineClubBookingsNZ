/**
 * Real-PostgreSQL proof of #4046: when Xero voids the refund credit note a
 * payment's `xeroRefundCreditNoteId` names, the link write that deactivates the
 * local mirror also moves that pointer - to the newest other live note that may
 * be canonical (never a #3880 per-refund note), or to null - in the same
 * transaction. The nightly "Missing refund credit note links" report reads the
 * pointer as a promise that an active link exists, so the pointer must always
 * name an active link or nothing.
 *
 * #4091: the same holds for the one canonical note of a bank-transfer payment,
 * whose mirror the funnel used to keep active after the void.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4046-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4046-member";
const LODGE_ID = "race-4046-lodge";
const BOOKING_ID = "race-4046-booking";
const PAYMENT_ID = "race-4046-payment";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeVoidPointerRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-note void pointer proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-note void pointer proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-note void pointer proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-note void pointer proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let upsertXeroObjectLink: (typeof import("@/lib/xero-sync"))["upsertXeroObjectLink"];
let reconcileXeroCreditNote: (typeof import("@/lib/xero-inbound/credit-note"))["reconcileXeroCreditNote"];

(RUN ? describe : describe.skip)(
  "a voided refund credit note moves the payment's pointer in the same write - real PostgreSQL (#4046)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function paymentWithNotes(
      source: "STRIPE" | "INTERNET_BANKING",
      pointer: string,
      notes: Array<{ id: string; createdAt: string; metadata: Record<string, unknown> }>,
    ) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source, status: "SUCCEEDED",
          refundedAmountCents: 20_000, xeroRefundCreditNoteId: pointer,
        },
      });
      for (const note of notes) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.id,
            role: "REFUND_CREDIT_NOTE", active: true, metadata: note.metadata as never, createdAt: new Date(note.createdAt),
          },
        });
      }
    }

    function voidNote(noteId: string, options?: Parameters<typeof upsertXeroObjectLink>[1]) {
      return upsertXeroObjectLink(
        {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED" }, mergeMetadata: true,
        },
        options,
      );
    }

    async function state() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        select: { xeroObjectId: true, active: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return { pointer: payment.xeroRefundCreditNoteId, active: links.filter((link) => link.active).map((link) => link.xeroObjectId) };
    }

    /** The report's "missing" predicate: a pointer must name an active link, or be empty. */
    function expectNoMissingLink({ pointer, active }: { pointer: string | null; active: string[] }) {
      expect(pointer === null || active.includes(pointer)).toBe(true);
    }

    beforeAll(async () => {
      assertSafeVoidPointerRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ upsertXeroObjectLink } = await import("@/lib/xero-sync"));
      ({ reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note"));

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4046 Lodge", slug: "race-4046" } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("a card payment's voided latest note: mirror off, pointer on the newest other live note", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000 } },
      ]);

      await voidNote("cn_latest");

      const after = await state();
      expect(after).toEqual({ pointer: "cn_first", active: ["cn_first"] });
      expectNoMissingLink(after);

      // A redelivery of the same void moves nothing.
      await voidNote("cn_latest");
      expect(await state()).toEqual(after);
    });

    it("the last live note voided: the pointer is cleared", async () => {
      await paymentWithNotes("STRIPE", "cn_only", [
        { id: "cn_only", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);

      await voidNote("cn_only");

      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
    });

    it("never records a per-refund note as the pointer (#3880)", async () => {
      // A field an older writer pointed at a per-refund note, which Xero then voids.
      await paymentWithNotes("INTERNET_BANKING", "cn_per_refund_old", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 10_000 } },
        { id: "cn_per_refund_old", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
        { id: "cn_per_refund_new", createdAt: "2026-06-03T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
      ]);

      await voidNote("cn_per_refund_old");

      const after = await state();
      expect(after).toEqual({ pointer: "cn_canonical", active: ["cn_canonical", "cn_per_refund_new"] });
      expectNoMissingLink(after);
    });

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function withFakeXero<T>(note: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4046" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /**
     * Every value committed to this payment's pointer while `run` executes,
     * recorded by a temporary trigger so a write that a later step undoes is
     * still seen.
     */
    async function recordPointerWrites(run: () => Promise<unknown>): Promise<Array<string | null>> {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS race_4046_pointer_writes (seq serial PRIMARY KEY, note_id text)`);
      await prisma.$executeRawUnsafe(`TRUNCATE race_4046_pointer_writes`);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION race_4046_record_pointer() RETURNS trigger AS $$
        BEGIN
          IF NEW."id" = '${PAYMENT_ID}' AND NEW."xeroRefundCreditNoteId" IS DISTINCT FROM OLD."xeroRefundCreditNoteId" THEN
            INSERT INTO race_4046_pointer_writes (note_id) VALUES (NEW."xeroRefundCreditNoteId");
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4046_pointer_trigger ON "Payment"`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER race_4046_pointer_trigger AFTER UPDATE OF "xeroRefundCreditNoteId" ON "Payment" FOR EACH ROW EXECUTE FUNCTION race_4046_record_pointer()`,
      );
      try {
        await run();
        const rows = await prisma.$queryRawUnsafe<Array<{ note_id: string | null }>>(
          `SELECT note_id FROM race_4046_pointer_writes ORDER BY seq`,
        );
        return rows.map((row) => row.note_id);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4046_pointer_trigger ON "Payment"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4046_record_pointer()`);
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS race_4046_pointer_writes`);
      }
    }

    it("an inbound reconcile of a card payment's only note, voided, never writes the voided note back into the pointer", async () => {
      await paymentWithNotes("STRIPE", "cn_only", [
        { id: "cn_only", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      const voided = {
        creditNoteID: "cn_only", creditNoteNumber: "CN-4046", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };

      // The first link loop clears the pointer. Before the fix the
      // canonical-backfill pass then wrote the voided note straight back (one
      // commit), and only the second link loop cleared it again - so a throw
      // between the two left the report's "missing link" in place.
      const writes = await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_only")));

      expect(writes).not.toContain("cn_only");
      expect(writes).toEqual([null]);
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);

      // A redelivery writes nothing.
      expect(await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_only"))))
        .toEqual([]);
      expect(await state()).toEqual(after);
    });

    /** What the nightly report and the coverage sum say about this payment's refund notes. */
    async function reportedRefundNoteState() {
      const { buildXeroReconciliationReport } = await import("@/lib/xero-hardening-report");
      const { sumCoveredRefundCreditNoteCents } = await import("@/lib/xero-sync");
      const drift = (await buildXeroReconciliationReport(CLUB_FORMAT_TEST)).issueSections
        .filter((section) => section.id === "canonical-link-drift")
        .flatMap((section) => section.items)
        .filter((item) => item.localId === PAYMENT_ID && item.xeroObjectType === "CREDIT_NOTE")
        .map((item) => item.xeroObjectId);
      return { drift, coveredCents: await sumCoveredRefundCreditNoteCents(PAYMENT_ID) };
    }

    it("a bank-transfer payment's one canonical note, voided inbound: mirror off, pointer released, no live note anywhere (#4091)", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      const before = await reportedRefundNoteState();
      expect(before).toEqual({ drift: [], coveredCents: 20_000 });
      const voided = {
        creditNoteID: "cn_canonical", creditNoteNumber: "CN-4091", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };

      // Before the fix the canonical branch kept the mirror active - the field
      // named it - so the pointer stayed on a voided note and every reader of
      // an active link saw a live refund note that Xero had cancelled.
      const writes = await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical")));

      expect(writes).toEqual([null]);
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
      // The refund has no live note: nothing covers it, and the report shows no
      // pointer promising a link that is not there.
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 0 });

      // The nightly cleanup and a redelivery of the void change nothing.
      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"))))
        .toEqual([]);
      expect(await state()).toEqual(after);
    });

    it("a refund note requested again after the void raises a fresh note and never re-adopts the voided one (#4091 owner decision)", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      // The create that raised it, which the single-note lookup falls back to.
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", xeroObjectNumber: "CN-4091",
          correlationKey: "race-4091-original-create", completedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      const voided = {
        creditNoteID: "cn_canonical", creditNoteNumber: "CN-4091", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };
      await withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"));

      // A rerun of the refund's request. Before the decision it found the
      // voided note through its create, wrote it back into the pointer and
      // re-armed its mirror, and raised nothing.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 20_000);
      // A redelivery of the void after it changes nothing either.
      await withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"));

      expect(queued.queueOperationId).not.toBeNull();
      const fresh = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: queued.queueOperationId! } });
      expect(fresh).toMatchObject({ operationType: "CREATE", entityType: "CREDIT_NOTE", status: "PENDING", xeroObjectId: null });
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
    });

    it("a bank-transfer canonical note voided beside a live per-refund note: only the canonical mirror goes off (#4091, #3880)", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_per_refund", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
      ]);

      await voidNote("cn_canonical");

      const after = await state();
      // The per-refund note keeps covering its own refund and never becomes the pointer.
      expect(after).toEqual({ pointer: null, active: ["cn_per_refund"] });
      expectNoMissingLink(after);
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 5_000 });
    });

    it("the pointer move commits or rolls back with the mirror write", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000 } },
      ]);

      await expect(
        prisma.$transaction(async (tx) => {
          await voidNote("cn_latest", { store: tx });
          throw new Error("abort after the void write");
        }),
      ).rejects.toThrow("abort after the void write");

      expect(await state()).toEqual({ pointer: "cn_latest", active: ["cn_first", "cn_latest"] });
    });
  },
);
