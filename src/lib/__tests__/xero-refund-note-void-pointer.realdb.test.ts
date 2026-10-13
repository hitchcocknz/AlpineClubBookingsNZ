/**
 * Real-PostgreSQL proof of #4046: when Xero voids the refund credit note a
 * payment's `xeroRefundCreditNoteId` names, the link write that deactivates the
 * local mirror also moves that pointer - to the newest other live note that may
 * be canonical (never a #3880 per-refund note), or to null - in the same
 * transaction. The nightly "Missing refund credit note links" report reads the
 * pointer as a promise that an active link exists, so the pointer must always
 * name an active link or nothing.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4046-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

(RUN ? describe : describe.skip)(
  "a voided refund credit note moves the payment's pointer in the same write - real PostgreSQL (#4046)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
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
