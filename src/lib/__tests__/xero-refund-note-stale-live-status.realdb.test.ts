/**
 * Real-PostgreSQL proof of #4288 (`INV-ADDPAY-041`, owner decision 24 Oct
 * 2026): an older explicit LIVE reading of a refund credit note never revives
 * a mirror a later write recorded VOIDED.
 *
 * The writers that name a live status read Xero outside any transaction: the
 * inbound reconcile, the Stripe status recorder, and the hand-made note answer.
 * A reading taken before the void and written after it used to write the
 * mirror back active, erase the VOIDED status, retire siblings on the
 * bank-transfer canonical path and let the inbound gate re-set the pointer.
 * Every refund-note link write now re-reads its row under its own row lock and
 * keeps a stored void (`judgeRefundNoteWrite`); between two live readings the
 * one with the older Xero `UpdatedDateUTC` keeps the stored snapshot.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it, and the schedule shapes of
 * `xero-canonical-refund-note-void-race.realdb.test.ts`; it owns and cleans its
 * own `race-4288-` fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4288";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BT_BOOKING = `${P}-bt-booking`;
const CARD_BOOKING = `${P}-card-booking`;
/** A bank-transfer payment and a card payment, each with two refund notes. */
const BT = `${P}-bt`;
const CARD = `${P}-card`;
const NOTE = `cn-${P}-stale`;
const REPLACEMENT = `cn-${P}-replacement`;
const REQUEST_ID = `${P}-request`;
const EARLY = "2026-06-30T11:00:00.000Z";
const LATE = "2026-06-30T12:00:00.000Z";

type Case = "bank-transfer canonical" | "Stripe per-delta" | "bank-transfer per-refund" | "refund request";
const ROLE: Record<Case, string> = {
  "bank-transfer canonical": "REFUND_CREDIT_NOTE",
  "Stripe per-delta": "REFUND_CREDIT_NOTE",
  "bank-transfer per-refund": "REFUND_CREDIT_NOTE",
  "refund request": "REFUND_REQUEST_CREDIT_NOTE",
};
const PAYMENT: Record<Case, string> = {
  "bank-transfer canonical": BT,
  "Stripe per-delta": CARD,
  "bank-transfer per-refund": BT,
  "refund request": BT,
};

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** A Xero reading of `NOTE`, as the SDK returns it. */
function reading(status: string, updatedAt: string) {
  return {
    creditNoteID: NOTE, creditNoteNumber: "CN-4288", status, total: 100, appliedAmount: 0,
    remainingCredit: status === "VOIDED" ? 0 : 100, updatedDateUTC: new Date(updatedAt), allocations: [], payments: [],
  };
}

(RUN ? describe : describe.skip)(
  "an older live Xero reading never revives a voided refund-note mirror - real PostgreSQL (#4288)",
  { timeout: 60_000 },
  () => {
    async function deleteLinksAndPayments() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: { in: [BT, CARD] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BT, CARD] } } });
      await prisma.payment.deleteMany({ where: { id: { in: [BT, CARD] } } });
    }
    async function deleteFixtures() {
      await deleteLinksAndPayments();
      await prisma.booking.deleteMany({ where: { id: { in: [BT_BOOKING, CARD_BOOKING] } } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Stale live refund-note status");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stale", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4288 Lodge", slug: "race-4288" } });
      for (const id of [BT_BOOKING, CARD_BOOKING]) {
        await prisma.booking.create({
          data: {
            id, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000,
            checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
          },
        });
      }
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /**
     * Both payments, refunded in part. The stale note was read live; a
     * replacement live sibling of the same role stands beside it. On the
     * bank-transfer canonical case the stale note is the payment's one note,
     * named by the pointer, and the replacement a per-refund note.
     */
    async function seed(kase: Case, options: { storedStatus?: string; storedAt?: string } = {}) {
      await deleteLinksAndPayments();
      await prisma.payment.create({
        data: {
          id: BT, bookingId: BT_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 15_000,
          xeroInvoiceId: `inv-${P}-bt`, xeroRefundCreditNoteId: kase === "bank-transfer canonical" ? NOTE : null,
        },
      });
      await prisma.payment.create({
        data: { id: CARD, bookingId: CARD_BOOKING, amountCents: 20_000, source: "STRIPE", status: "PARTIALLY_REFUNDED", refundedAmountCents: 15_000, xeroInvoiceId: `inv-${P}-card` },
      });
      const own = {
        ...(kase === "refund request" ? { refundRequestId: REQUEST_ID } : {}),
        ...(kase === "bank-transfer per-refund" ? { perDelta: true } : {}),
      };
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288",
          role: ROLE[kase], active: true,
          metadata: { amountCents: 10_000, watermarkCents: 10_000, ...own, status: options.storedStatus ?? "AUTHORISED", total: 100, providerUpdatedAt: options.storedAt ?? "2026-06-30T10:00:00.000Z" },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: REPLACEMENT, xeroObjectNumber: "CN-4288-2",
          role: ROLE[kase], active: true,
          metadata: {
            amountCents: 5_000, watermarkCents: 15_000, status: "AUTHORISED", total: 50, providerUpdatedAt: LATE,
            ...(kase === "refund request" ? { refundRequestId: REQUEST_ID } : { perDelta: true }),
          },
        },
      });
    }

    /** The link write the inbound reconcile sends for a reading, on the caller's transaction or its own. */
    async function writeReading(kase: Case, status: string, updatedAt: string, store?: import("@prisma/client").Prisma.TransactionClient) {
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const { xeroCreditNoteSnapshotMetadata } = await import("@/lib/xero-refund-note-status");
      return upsertXeroObjectLink(
        {
          localModel: "Payment", localId: PAYMENT[kase], xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288",
          role: ROLE[kase], metadata: xeroCreditNoteSnapshotMetadata(reading(status, updatedAt)), mergeMetadata: true,
        },
        store ? { store } : undefined,
      );
    }

    /** A fake Xero (no provider call), and no alert, for the length of `run`. */
    async function withFakeXero<T>(getCreditNote: (tenant: string, id: string) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
      const apiClient = await import("@/lib/xero-api-client");
      const alerts = await import("@/lib/xero-error-alert");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: { getCreditNote } }, tenantId: "tenant-4288" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /**
     * The stale writer for each case, paused at `gate` after it read the note
     * as live and before its link write: the real inbound reconcile (after its
     * link reads), the real Stripe status recorder (in its Xero fetch, after
     * its link reads), or the link write a reconcile sends for a per-refund or
     * request note.
     */
    async function staleLiveWriter(kase: Case, gate: Promise<void>, reached: () => void): Promise<unknown> {
      const authorised = reading("AUTHORISED", EARLY);
      if (kase === "bank-transfer canonical") {
        const objectLinks = await import("@/lib/xero-inbound/object-links");
        const original = objectLinks.findActiveXeroObjectLinks;
        const spy = vi.spyOn(objectLinks, "findActiveXeroObjectLinks").mockImplementationOnce(async (...args: Parameters<typeof original>) => {
          const rows = await original(...args);
          reached();
          await gate;
          return rows;
        });
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        try {
          return await withFakeXero(async () => ({ body: { creditNotes: [authorised] } }), () => reconcileXeroCreditNote(NOTE));
        } finally {
          spy.mockRestore();
        }
      }
      if (kase === "Stripe per-delta") {
        const { recordStripeRefundNoteLinkStatuses } = await import("@/lib/xero-refund-note-status-recorder");
        return withFakeXero(
          async (_tenant, id) => {
            if (id !== NOTE) return { body: { creditNotes: [{ ...reading("AUTHORISED", LATE), creditNoteID: REPLACEMENT, creditNoteNumber: "CN-4288-2", total: 50 }] } };
            reached();
            await gate;
            return { body: { creditNotes: [authorised] } };
          },
          () => recordStripeRefundNoteLinkStatuses({ paymentIds: [CARD] }),
        );
      }
      reached();
      await gate;
      return writeReading(kase, "AUTHORISED", EARLY);
    }

    async function state(kase: Case) {
      const { sumCoveredRefundCreditNoteCents } = await import("@/lib/xero-sync");
      const { refundRequestOwnNotes } = await import("@/lib/xero-refund-note-status");
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT[kase], role: ROLE[kase] },
        select: { xeroObjectId: true, active: true, metadata: true },
      });
      const note = links.find((link) => link.xeroObjectId === NOTE)!;
      const replacement = links.find((link) => link.xeroObjectId === REPLACEMENT)!;
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT[kase] }, select: { xeroRefundCreditNoteId: true } });
      const metadata = note.metadata as Record<string, unknown>;
      return {
        active: note.active,
        status: metadata.status,
        providerUpdatedAt: metadata.providerUpdatedAt,
        pointer: payment.xeroRefundCreditNoteId,
        replacementActive: replacement.active,
        coverage: kase === "refund request"
          ? (await refundRequestOwnNotes(BT, REQUEST_ID, prisma)).live?.xeroObjectId ?? null
          : await sumCoveredRefundCreditNoteCents(PAYMENT[kase]),
      };
    }
    /** What every case must end with: the void kept, the replacement alone covering. */
    const kept = (kase: Case) => ({
      active: false, status: "VOIDED", providerUpdatedAt: LATE, pointer: null, replacementActive: true,
      coverage: kase === "refund request" ? REPLACEMENT : 5_000,
    });

    /** Poll until a backend waits on a lock `blockerPid` holds. */
    async function waitForBlockedBy(blockerPid: number, waiterPid?: number) {
      const startedAt = process.hrtime.bigint();
      while (realElapsedMs(startedAt) < 10_000) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
          WHERE datname = current_database() AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
            AND (${waiterPid ?? null}::int IS NULL OR pid = ${waiterPid ?? null}::int)
        `;
        if ((rows[0]?.count ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for a link write to queue behind pid ${blockerPid}.`);
    }

    /** A reading's link write held open on its own connection until `release()`. */
    async function holdReading(kase: Case, status: string, updatedAt: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let written!: (pid: number) => void;
      const holderPid = new Promise<number>((resolve) => (written = resolve));
      const committed = prisma.$transaction(
        async (tx) => {
          await writeReading(kase, status, updatedAt, tx);
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
          written(pid);
          await released;
        },
        { timeout: 30_000 },
      );
      const pid = await Promise.race([holderPid, committed.then(() => { throw new Error("Held write ended before reporting its lock"); })]);
      return { pid, release, committed };
    }

    const CASES: Case[] = ["bank-transfer canonical", "Stripe per-delta", "bank-transfer per-refund", "refund request"];

    it.each(CASES)("%s: a live reading taken before the void and written after it keeps the void (schedule A)", async (kase) => {
      await seed(kase);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      const stale = staleLiveWriter(kase, gate, reached);
      void stale.catch(() => undefined);
      try {
        await Promise.race([atGate, stale.then(() => { throw new Error("The stale writer finished before its gate"); })]);
        // B: the void's own write commits while A holds its live reading.
        await writeReading(kase, "VOIDED", LATE);
      } finally {
        release();
      }
      await stale;

      // Before #4288: active, AUTHORISED, and on the canonical path the pointer back on the note.
      expect(await state(kase)).toEqual(kept(kase));
    });

    it("bank-transfer canonical: a live reconcile queued on the void's row lock keeps the void (lock-queued)", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase);
      const held = await holdReading(kase, "VOIDED", LATE);
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      // It reads the note as live and active: the void has not committed.
      const stale = withFakeXero(async () => ({ body: { creditNotes: [reading("AUTHORISED", EARLY)] } }), () => reconcileXeroCreditNote(NOTE));
      void stale.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await stale;
      expect(await state(kase)).toEqual(kept(kase));
    });

    it("MUTATION (order): an older live reading queued behind a newer live one keeps the newer snapshot (lock-queued)", async () => {
      const kase: Case = "Stripe per-delta";
      await seed(kase, { storedAt: "2026-06-30T09:00:00.000Z" });
      const held = await holdReading(kase, "PAID", LATE);
      const stale = writeReading(kase, "AUTHORISED", EARLY);
      void stale.catch(() => undefined);
      try {
        await waitForBlockedBy(held.pid);
      } finally {
        held.release();
      }
      await held.committed;
      await stale;
      expect(await state(kase)).toMatchObject({ active: true, status: "PAID", providerUpdatedAt: LATE, coverage: 15_000 });
    });

    it("a newer live reading is applied through the real reconcile: AUTHORISED to PAID is ordinary", async () => {
      const kase: Case = "bank-transfer canonical";
      await seed(kase, { storedAt: EARLY });
      const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
      await withFakeXero(async () => ({ body: { creditNotes: [reading("PAID", LATE)] } }), () => reconcileXeroCreditNote(NOTE));
      expect(await state(kase)).toEqual({ active: true, status: "PAID", providerUpdatedAt: LATE, pointer: NOTE, replacementActive: true, coverage: 15_000 });
    });

    it("MUTATION (pointer): a stale live write keeps the void without waiting on the Payment a Payment-first enqueue holds (race)", async () => {
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const { lockPaymentForRefundedTotal } = await import("@/lib/payment-transactions");
      const kase: Case = "bank-transfer canonical";
      // The void committed, but its pointer still names the note (a reconcile's
      // gate wrote it back before the void, or the void found Payment busy).
      await deleteLinksAndPayments();
      await prisma.payment.create({
        data: {
          id: BT, bookingId: BT_BOOKING, amountCents: 20_000, source: "INTERNET_BANKING", status: "REFUNDED", refundedAmountCents: 20_000,
          xeroInvoiceId: `inv-${P}-bt`, xeroRefundCreditNoteId: NOTE,
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: BT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE, xeroObjectNumber: "CN-4288", role: "REFUND_CREDIT_NOTE", active: false,
          metadata: { amountCents: 20_000, watermarkCents: 20_000, status: "VOIDED", total: 200, providerUpdatedAt: LATE },
        },
      });
      // F takes the Payment lock a group cancel's refund writer takes, and
      // holds it until K has finished; then it runs the real enqueue.
      let mayEnqueue!: () => void;
      const gate = new Promise<void>((resolve) => (mayEnqueue = resolve));
      let locked!: () => void;
      const paymentLocked = new Promise<void>((resolve) => (locked = resolve));
      const enqueue = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await lockPaymentForRefundedTotal(tx, BT);
        locked();
        await gate;
        return enqueueXeroRefundCreditNoteOperation(BT, 20_000, { refundMethod: "internet-banking", store: tx });
      }, { timeout: 30_000 });
      void enqueue.catch(() => undefined);
      // A blocking-lock mutation makes K wait for F; the backstop lets F run
      // so the cycle (or the elapsed-time check) fails rather than hangs.
      const backstop = setTimeout(mayEnqueue, 10_000);
      try {
        await Promise.race([paymentLocked, enqueue.then(() => { throw new Error("Enqueue ended before reporting its Payment lock"); })]);
        // K: the stale live reading's write, with F holding the Payment.
        const startedAt = process.hrtime.bigint();
        await writeReading(kase, "AUTHORISED", EARLY);
        expect(realElapsedMs(startedAt)).toBeLessThan(5_000);
        // The void is kept; the busy Payment leaves only the pointer to the heal.
        const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: BT, xeroObjectId: NOTE }, select: { active: true, metadata: true } });
        expect(link.active).toBe(false);
        expect(link.metadata).toMatchObject({ status: "VOIDED", providerUpdatedAt: LATE });
      } finally {
        clearTimeout(backstop);
        mayEnqueue();
      }
      // F finishes too: no lock cycle between the link and the Payment.
      await expect(enqueue).resolves.toBeDefined();
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: BT, xeroObjectId: NOTE }, select: { active: true, metadata: true } });
      expect(link).toMatchObject({ active: false, metadata: expect.objectContaining({ status: "VOIDED" }) });
    });
  },
);
