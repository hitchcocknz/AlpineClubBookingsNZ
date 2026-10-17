/**
 * Real-PostgreSQL proof of #4162 (owner decisions 16 and 17 Oct 2026,
 * `INV-ADDPAY-042`): the treasurer's two answers to a bank-transfer refund
 * whose Xero credit note was voided.
 *
 * - The probe first (blueprint stop condition 1): an inbound void of a bank
 *   transfer's refund note recounts only `Payment.refundedAmountCents`; the
 *   hand-back's `PaymentTransaction` allocation and its `BANK_REFUND` line stand.
 * - The list shows a voided note once it is inactive and past the grace window,
 *   on a bank transfer, as a `REFUND_CREDIT_NOTE` only.
 * - Record again puts the total back, queues ONE note keyed on its record, and
 *   the worker raises it under that key for exactly the voided amount.
 * - A double click records once (`lock(1)`, then the Payment row, then the
 *   unique pair).
 * - Confirm cancelled unwinds the allocation and reverses the line, so the
 *   detail matches the total; "replaced in Xero" moves nothing.
 * - An inbound void delivered inside the window lowers the total again, and
 *   the note is still raised in full; the total corrects when it lands.
 * - #4161's heal defers while a record-again holds the Payment row.
 * - A draining older worker running a record-again row raises the voided
 *   amount, never more, under a key that never replays the voided note's.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4162-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4162-member";
const OFFICER_ID = "race-4162-officer";
const LODGE_ID = "race-4162-lodge";
const BOOKING_ID = "race-4162-booking";
const PAYMENT_ID = "race-4162-payment";
const TXN_ID = "race-4162-txn";
const INVOICE_ID = "inv-race-4162";
const PAID_CENTS = 20_000;
/** Older than the 24-hour grace window as the frozen clock reads it (2026-07-01T00:00Z). */
const VOIDED_LONG_AGO = new Date("2026-06-28T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
function assertSafeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Bank-refund void proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run bank-refund void proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Bank-refund void proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Bank-refund void proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let resolution: typeof import("@/lib/bank-refund-void-resolution");
let report: typeof import("@/lib/bank-refund-void-report");
let retry: typeof import("@/lib/bank-refund-void-retry");

(RUN ? describe : describe.skip)(
  "a voided bank-transfer refund note is recorded again or confirmed cancelled - real PostgreSQL (#4162)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.bankRefundVoidResolution.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { sourceBookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /** A paid bank-transfer booking, cancelled, with no refund yet. */
    async function paidBankTransfer(source: "INTERNET_BANKING" | "STRIPE" = "INTERNET_BANKING") {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source, status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source, amountCents: PAID_CENTS, status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
    }

    /**
     * A refund handed back by bank transfer and noted in Xero, as the real
     * writers record it: the completed task, the allocation, its BANK_REFUND
     * line, the note's create row and its link (the payment's one note).
     */
    async function handBackNoted(noteId: string, cents: number, options?: { taskId?: string; perDelta?: boolean }) {
      const { applyLocalRefundAllocation } = await import("@/lib/payment-transactions");
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      const { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } = await import("@/lib/xero-operation-outbox-payload");
      const taskId = options?.taskId ?? `race-4162-task-${noteId}`;
      await prisma.$transaction(async (tx) => {
        await tx.manualRefundTask.create({
          data: {
            id: taskId, bookingId: BOOKING_ID, paymentId: PAYMENT_ID, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: cents,
            raisedAmountCents: cents, status: "COMPLETED", completedAt: new Date(), completedByMemberId: OFFICER_ID, reason: "race-4162",
          },
        });
        await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: cents, store: tx });
        await postHandBackLedgerLine({
          bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: taskId, amountCents: cents, refundMethod: "internet-banking",
          paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
        });
      });
      const key = `payment:${PAYMENT_ID}:refund-credit-note:${cents}:v1`;
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          correlationKey: key, idempotencyKey: key, queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          completedAt: new Date("2026-06-01T00:00:00.000Z"),
          requestPayload: {
            refundMethod: "internet-banking", watermarkCents: cents, allocation: { invoiceId: INVOICE_ID, amount: cents / 100 },
            ...(options?.taskId ? { reviewTaskId: options.taskId } : {}),
            ...(options?.perDelta ? { perDelta: true } : {}),
          },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          role: "REFUND_CREDIT_NOTE", active: true,
          // As the inbound sync leaves a live note: Xero's status and total merged on.
          metadata: { amountCents: cents, watermarkCents: cents, status: "AUTHORISED", total: cents / 100, ...(options?.perDelta ? { perDelta: true } : {}) },
        },
      });
      if (!options?.perDelta) {
        await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroRefundCreditNoteId: noteId } });
      }
      return taskId;
    }

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function inbound(note: Record<string, unknown>) {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(note.creditNoteID as string);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    function voidedNote(noteId: string, cents: number) {
      return { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "VOIDED", total: cents / 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] };
    }

    /** Xero voids the note; the void is then older than the grace window. */
    async function voidLongAgo(noteId: string, cents: number) {
      await inbound(voidedNote(noteId, cents));
      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${VOIDED_LONG_AGO} WHERE "localId" = ${PAYMENT_ID} AND "xeroObjectId" = ${noteId}`;
    }

    async function linkIdOf(noteId: string) {
      return (await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID, xeroObjectId: noteId }, select: { id: true } })).id;
    }

    async function money() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });
      const txn = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: TXN_ID }, select: { refundedAmountCents: true, status: true } });
      const lines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, kind: "BANK_REFUND" },
        select: { id: true, amountCents: true, postingKey: true, reversesLineId: true },
        orderBy: { reversesLineId: { sort: "asc", nulls: "first" } },
      });
      return { payment, txn, lines };
    }

    /**
     * The outbox's call for one queued refund-note row, against a fake Xero.
     * `asOlderWorker` runs it as the previous release would: that worker knows
     * no `reRecordId`, so it is not passed. Returns the Xero keys and amounts.
     */
    async function raiseQueuedNote(operationId: string, options?: { asOlderWorker?: boolean; noteId?: string; viaOutbox?: boolean }) {
      const sent: Array<{ key: string; amount: number }> = [];
      const noteId = options?.noteId ?? "cn-race-4162-fresh";
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            sent.push({ key: key!, amount: total });
            return { body: { creditNotes: [{ creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4162"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          opts.run({ contactId: opts.currentContactId })) as never),
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4162" }),
      ];
      try {
        if (options?.viaOutbox) {
          // The outbox worker itself: its claim and its dispatch of the payload.
          const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
          await processQueuedXeroOutboxOperations({ limit: 10 });
          return sent;
        }
        const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { requestPayload: true } });
        const payload = row.requestPayload as { refundAmountCents: number; watermarkCents: number; reRecordId?: string; creditsInvoiceId?: string };
        await createXeroCreditNote(PAYMENT_ID, payload.refundAmountCents, {
          syncOperationId: operationId,
          watermarkCents: payload.watermarkCents,
          refundMethod: "internet-banking",
          ...(options?.asOlderWorker ? {} : { reRecordId: payload.reRecordId, creditsInvoiceId: payload.creditsInvoiceId }),
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return sent;
    }

    function reRecord(linkId: string, cents = PAID_CENTS) {
      return resolution.reRecordBankTransferRefund({ linkId, expectedAmountCents: cents, note: "Paid by bank on 2 June", actingMemberId: OFFICER_ID });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      resolution = await import("@/lib/bank-refund-void-resolution");
      report = await import("@/lib/bank-refund-void-report");
      retry = await import("@/lib/bank-refund-void-retry");

      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Proof", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4162 Lodge", slug: "race-4162" } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: new Date("2026-08-01T00:00:00.000Z"),
          checkOut: new Date("2026-08-03T00:00:00.000Z"), status: "CANCELLED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
        },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CANCELLED" } });
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("probe: an inbound void recounts only the refunded total - the allocation and the BANK_REFUND line stand (finding 2)", async () => {
      await paidBankTransfer();
      const taskId = await handBackNoted("cn-race-4162-v", PAID_CENTS);
      expect(await money()).toMatchObject({
        payment: { refundedAmountCents: PAID_CENTS, status: "REFUNDED" },
        txn: { refundedAmountCents: PAID_CENTS, status: "REFUNDED" },
        lines: [{ amountCents: -PAID_CENTS, postingKey: `handback:${taskId}`, reversesLineId: null }],
      });

      await inbound(voidedNote("cn-race-4162-v", PAID_CENTS));

      expect(await money()).toMatchObject({
        payment: { refundedAmountCents: 0, status: "SUCCEEDED" },
        txn: { refundedAmountCents: PAID_CENTS, status: "REFUNDED" },
        lines: [{ amountCents: -PAID_CENTS, postingKey: `handback:${taskId}`, reversesLineId: null }],
      });
    });

    it("lists a voided note once inactive and past the grace window, on a bank transfer, as a refund note only", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      // A modification note on the same payment, voided too: another role, never listed (#4195 for requests).
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4162-mod", role: "MODIFICATION_CREDIT_NOTE",
          active: false, metadata: { status: "VOIDED", amountCents: 5_000 },
        },
      });
      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${VOIDED_LONG_AGO} WHERE "xeroObjectId" = 'cn-race-4162-mod'`;
      const mine = async () => (await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID);
      expect(await mine()).toEqual([]);

      await inbound(voidedNote("cn-race-4162-v", PAID_CENTS));
      // Inside the grace window: not yet.
      expect(await mine()).toEqual([]);

      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${VOIDED_LONG_AGO} WHERE "xeroObjectId" = 'cn-race-4162-v'`;
      expect(await mine()).toEqual([
        expect.objectContaining({
          linkId: await linkIdOf("cn-race-4162-v"), voidedCreditNoteId: "cn-race-4162-v", amountCents: PAID_CENTS,
          liveNotes: [], flag: null, reRecordRefusal: null, answerable: true,
        }),
      ]);
      expect(await report.countBankRefundVoids()).toBeGreaterThanOrEqual(1);
    });

    it("reads a status stored in another case or with spaces as the link reader does", async () => {
      await paidBankTransfer();
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4162-lower", role: "REFUND_CREDIT_NOTE",
          active: false, metadata: { status: " voided ", amountCents: PAID_CENTS },
        },
      });
      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${VOIDED_LONG_AGO} WHERE "xeroObjectId" = 'cn-race-4162-lower'`;
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID).map((item) => item.voidedCreditNoteId)).toEqual(["cn-race-4162-lower"]);
    });

    it("never lists a card payment's voided note: the card report and its self-heal own those", async () => {
      await paidBankTransfer("STRIPE");
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4162-card", role: "REFUND_CREDIT_NOTE",
          active: false, metadata: { status: "VOIDED", amountCents: PAID_CENTS },
        },
      });
      await prisma.$executeRaw`UPDATE "XeroObjectLink" SET "updatedAt" = ${VOIDED_LONG_AGO} WHERE "xeroObjectId" = 'cn-race-4162-card'`;
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    it("record again: the total comes back, one note row is keyed on the record, and the worker raises exactly the voided amount under it", async () => {
      await paidBankTransfer();
      const taskId = await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const eventsBefore = await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } });

      const result = await reRecord(await linkIdOf("cn-race-4162-v"));

      expect(result).toMatchObject({ paymentId: PAYMENT_ID, amountCents: PAID_CENTS, restoredCents: PAID_CENTS });
      // The detail already held the refund: no second allocation, no second line.
      expect(await money()).toMatchObject({
        payment: { refundedAmountCents: PAID_CENTS, status: "REFUNDED" },
        txn: { refundedAmountCents: PAID_CENTS },
        lines: [{ amountCents: -PAID_CENTS, postingKey: `handback:${taskId}`, reversesLineId: null }],
      });
      const stored = await prisma.bankRefundVoidResolution.findMany({ where: { paymentId: PAYMENT_ID } });
      expect(stored).toEqual([
        expect.objectContaining({
          id: result.resolutionId, voidedCreditNoteId: "cn-race-4162-v", outcome: "RE_RECORDED", amountCents: PAID_CENTS,
          resolvedByMemberId: OFFICER_ID, noteOperationId: result.noteOperationId,
        }),
      ]);
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: result.noteOperationId } });
      expect(row).toMatchObject({ status: "PENDING", operationType: "CREATE", entityType: "CREDIT_NOTE" });
      expect(row.correlationKey).toContain(`re-record:${result.resolutionId}`);
      // INV-PAY-101: the voided note's method and credited invoice.
      expect(row.requestPayload).toMatchObject({
        refundAmountCents: PAID_CENTS, reRecordId: result.resolutionId, refundMethod: "internet-banking", creditsInvoiceId: INVOICE_ID,
      });
      // Q3: no booking event; the audit row is the record.
      expect(await prisma.bookingEvent.count({ where: { bookingId: BOOKING_ID } })).toBe(eventsBefore);
      expect(await prisma.auditLog.count({ where: { action: "booking-payment.bank-refund.re-recorded", entityId: result.resolutionId, category: "payment" } })).toBe(1);
      // On its way: not listed.
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);

      const sent = await raiseQueuedNote(result.noteOperationId, { viaOutbox: true });

      expect(sent).toEqual([{ key: `payment:${PAYMENT_ID}:refund-credit-note:re-record:${result.resolutionId}:0:v3`, amount: PAID_CENTS / 100 }]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: result.noteOperationId }, select: { status: true } })).toEqual({ status: "SUCCEEDED" });
      expect(await prisma.xeroObjectLink.findFirst({ where: { localId: PAYMENT_ID, xeroObjectId: "cn-race-4162-fresh" }, select: { active: true } })).toEqual({ active: true });
      // Landed: still not listed.
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    it("MUTATION: the note is sized from its record, never the payment-wide gap", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      // Account credit the booking issued, which the payment-wide cash figure
      // takes off: that gap is $150 while the voided note was $200.
      await prisma.memberCredit.create({
        data: { memberId: MEMBER_ID, amountCents: 5_000, type: "CANCELLATION_REFUND", description: "race-4162", sourceBookingId: BOOKING_ID },
      });
      const result = await reRecord(await linkIdOf("cn-race-4162-v"));

      expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: result.noteOperationId } })).requestPayload).toMatchObject({
        refundAmountCents: PAID_CENTS,
      });
      expect(await raiseQueuedNote(result.noteOperationId)).toEqual([expect.objectContaining({ amount: PAID_CENTS / 100 })]);
    });

    it("a double click records once: one resolution, one note row, one raise of the total", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const linkId = await linkIdOf("cn-race-4162-v");

      const outcomes = await Promise.allSettled([reRecord(linkId), reRecord(linkId)]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(resolution.BankRefundVoidResolutionError);
      expect(refused.reason.status).toBe(409);
      expect(await prisma.bankRefundVoidResolution.count({ where: { paymentId: PAYMENT_ID } })).toBe(1);
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, status: "PENDING" } })).toBe(1);
      expect((await money()).payment.refundedAmountCents).toBe(PAID_CENTS);
    });

    it("the unique pair refuses a second answer for one voided note in the database itself", async () => {
      await paidBankTransfer();
      const data = {
        paymentId: PAYMENT_ID, voidedCreditNoteId: "cn-race-4162-v", outcome: "CONFIRMED_CANCELLED" as const, amountCents: PAID_CENTS,
        note: "first", resolvedByMemberId: OFFICER_ID, resolvedAt: new Date(),
      };
      await prisma.bankRefundVoidResolution.create({ data });
      await expect(prisma.bankRefundVoidResolution.create({ data: { ...data, outcome: "RE_RECORDED", note: "second" } })).rejects.toMatchObject({ code: "P2002" });
    });

    it("confirm cancelled: the allocation comes back out and the BANK_REFUND line is reversed, so the detail matches the total", async () => {
      await paidBankTransfer();
      const taskId = await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);

      const result = await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-v"), reason: "cancelled", expectedAmountCents: PAID_CENTS, note: "Member kept the stay credit", actingMemberId: OFFICER_ID,
      });

      expect(result).toMatchObject({ unwoundCents: PAID_CENTS, reason: "cancelled", reopenedTaskId: taskId });
      // A cancelled booking: the hand-back is owed again, back on the refund list (owner, 17 Oct 2026).
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, completedAt: true, completedByMemberId: true } })).toEqual({
        status: "OPEN", completedAt: null, completedByMemberId: null,
      });
      const after = await money();
      expect(after.payment).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      expect(after.txn).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      const original = after.lines.find((line) => line.postingKey === `handback:${taskId}`)!;
      expect(after.lines).toEqual([
        original,
        { id: expect.any(String), amountCents: PAID_CENTS, postingKey: `reversal:${original.id}`, reversesLineId: original.id },
      ]);
      expect(result.reversedLedgerLineId).toBe(original.id);
      // The census reads the reversal as well formed: its key, anchor and figures.
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      const evaluation = evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, BOOKING_ID))!);
      expect(evaluation.integrity).toEqual([]);
      expect(evaluation.identities.find((identity) => identity.identity === "REFUNDED")).toMatchObject({ status: "AGREE", columnCents: 0 });
      // A later reconcile derives the total from the detail: it no longer puts the refund back.
      const { reconcilePaymentAggregates } = await import("@/lib/payment-transactions");
      await reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
      expect((await money()).payment.refundedAmountCents).toBe(0);
      expect(await prisma.bankRefundVoidResolution.findFirst({ where: { paymentId: PAYMENT_ID } })).toMatchObject({
        // The reason is the outcome, never words in the note (owner, 17 Oct 2026).
        outcome: "CONFIRMED_CANCELLED", note: "Member kept the stay credit",
      });
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID, status: "PENDING" } })).toBe(0);
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    it("confirm cancelled one of two hand-backs: the census explains the refunded total by the live hand-back alone", async () => {
      // A live booking (an edit's refunds, say): nothing is reopened, so the task stays COMPLETED.
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "CONFIRMED" } });
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-live", 5_000, { perDelta: true });
      await handBackNoted("cn-race-4162-v", 15_000);
      await voidLongAgo("cn-race-4162-v", 15_000);

      await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-v"), reason: "cancelled", expectedAmountCents: 15_000, note: "Never sent", actingMemberId: OFFICER_ID,
      });

      expect(await money()).toMatchObject({ payment: { refundedAmountCents: 5_000 }, txn: { refundedAmountCents: 5_000 } });
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      const evaluation = evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, BOOKING_ID))!);
      expect(evaluation.integrity).toEqual([]);
      // MUTATION: a census that still counted the reversed hand-back would explain $200 against a $50 total.
      expect(evaluation.identities.find((identity) => identity.identity === "REFUNDED")).toMatchObject({
        status: "CLASSIFIED",
        columnCents: 5_000,
        explainedBy: [expect.objectContaining({ name: "REFUND_MIRROR_HAND_BACK", cents: 5_000 })],
      });
    });

    /** The booking's confirmation and cancellation charge lines, as a fully refunded cancelled booking holds them. */
    async function chargedAndCancelled() {
      const { postBookingLedgerLines } = await import("@/lib/booking-ledger-write");
      const { confirmationPromotionKey, reversalKey } = await import("@/lib/booking-ledger-posting-keys");
      const charge = {
        bookingId: BOOKING_ID, lodgeId: LODGE_ID, side: "CHARGE" as const, kind: "PROMOTION" as const, sign: 1 as const, quantity: 1,
        unitCents: PAID_CENTS, anchorKind: "CONFIRMATION" as const, anchorId: BOOKING_ID, narration: "race-4162 charge",
        postingKey: confirmationPromotionKey(BOOKING_ID),
      };
      await prisma.$transaction((tx) => postBookingLedgerLines(tx, [charge]));
      const line = await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: charge.postingKey }, select: { id: true } });
      await prisma.$transaction((tx) =>
        postBookingLedgerLines(tx, [{ ...charge, sign: -1, anchorKind: "CANCELLATION", narration: "Reversed: race-4162 charge", reversesLineId: line.id, postingKey: reversalKey(line.id) }]),
      );
    }

    async function census() {
      const { readBookingLedgerCensusRow } = await import("@/lib/booking-ledger-projection-census-store");
      const { evaluateBookingLedgerIdentities } = await import("@/lib/booking-ledger-projection-census");
      return evaluateBookingLedgerIdentities((await readBookingLedgerCensusRow(prisma, BOOKING_ID))!);
    }

    it("MUTATION: on a cancelled booking, confirm cancelled reopens the hand-back, and the census reads it as an open hand-back", async () => {
      await paidBankTransfer();
      await chargedAndCancelled();
      const taskId = await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      expect((await census()).identities.find((identity) => identity.identity === "PRICE")).toMatchObject({ status: "AGREE", ledgerCents: 0 });

      await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-v"), reason: "cancelled", expectedAmountCents: PAID_CENTS, note: "Never sent", actingMemberId: OFFICER_ID,
      });

      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } })).toEqual({ status: "OPEN" });
      const evaluation = await census();
      expect(evaluation.integrity).toEqual([]);
      // The club holds the money again, and the open hand-back says it is still owed.
      expect(evaluation.identities.find((identity) => identity.identity === "PRICE")).toMatchObject({
        status: "CLASSIFIED",
        explainedBy: [expect.objectContaining({ name: "IN_FLIGHT_HAND_BACK", cents: PAID_CENTS })],
      });
    });

    it("a hand-back completed again after its line was reversed posts a fresh line under the chain's next key", async () => {
      await paidBankTransfer();
      const taskId = await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const confirmed = await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-v"), reason: "cancelled", expectedAmountCents: PAID_CENTS, note: "Never sent", actingMemberId: OFFICER_ID,
      });
      const { postHandBackLedgerLine } = await import("@/lib/booking-ledger-hand-back");
      const { afterReversalKey, reversalKey } = await import("@/lib/booking-ledger-posting-keys");
      const post = () =>
        prisma.$transaction((tx) =>
          postHandBackLedgerLine({
            bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: taskId, amountCents: PAID_CENTS, refundMethod: "internet-banking",
            paymentSource: "INTERNET_BANKING", officerMemberId: OFFICER_ID, store: tx,
          }),
        );
      await post();
      await post();
      const reversal = await prisma.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: BOOKING_ID, postingKey: reversalKey(confirmed.reversedLedgerLineId!) }, select: { id: true } });
      const lines = await prisma.bookingLedgerLine.findMany({ where: { bookingId: BOOKING_ID, kind: "BANK_REFUND", reversesLineId: null }, select: { postingKey: true } });
      expect(lines.map((line) => line.postingKey).sort()).toEqual([`handback:${taskId}`, afterReversalKey(`handback:${taskId}`, reversal.id)].sort());
    });

    it("MUTATION: never a second note for money a live note credits - record again and cancelled are refused", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-o", PAID_CENTS);
      // A second live note D for the same hand-back, raised by hand in Xero, then voided.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-race-4162-d", xeroObjectNumber: "CN-D",
          role: "REFUND_CREDIT_NOTE", active: true, metadata: { amountCents: PAID_CENTS, status: "AUTHORISED", total: PAID_CENTS / 100, perDelta: true },
        },
      });
      await voidLongAgo("cn-race-4162-d", PAID_CENTS);
      const linkId = await linkIdOf("cn-race-4162-d");

      await expect(reRecord(linkId)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Replaced by hand in Xero") });
      await expect(
        resolution.confirmBankTransferRefundCancelled({ linkId, reason: "cancelled", expectedAmountCents: PAID_CENTS, note: "x", actingMemberId: OFFICER_ID }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Replaced by hand in Xero") });
      expect(await prisma.bankRefundVoidResolution.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
      await resolution.confirmBankTransferRefundCancelled({ linkId, reason: "replaced-in-xero", expectedAmountCents: PAID_CENTS, note: "O stands", actingMemberId: OFFICER_ID });
    });

    it("MUTATION: a voided re-recorded note's cancellation follows its record back to the hand-back task", async () => {
      await paidBankTransfer();
      const taskA = await handBackNoted("cn-race-4162-v", 10_000, { taskId: "race-4162-task-a" });
      await handBackNoted("cn-race-4162-o", 10_000, { perDelta: true });
      await voidLongAgo("cn-race-4162-v", 10_000);
      const recorded = await reRecord(await linkIdOf("cn-race-4162-v"), 10_000);
      await raiseQueuedNote(recorded.noteOperationId, { noteId: "cn-race-4162-w" });
      await voidLongAgo("cn-race-4162-w", 10_000);

      const confirmed = await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-w"), reason: "cancelled", expectedAmountCents: 10_000, note: "Never sent", actingMemberId: OFFICER_ID,
      });

      // Two lines of the same amount: only the record's trail says which is W's.
      expect(confirmed.reopenedTaskId).toBe(taskA);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskA }, select: { status: true } })).toEqual({ status: "OPEN" });
    });

    it("MUTATION: a record-again an older worker completed as covered by another note stays flagged, and Retry raises its note", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-l", 10_000, { perDelta: true });
      await handBackNoted("cn-race-4162-v", 10_000);
      await voidLongAgo("cn-race-4162-v", 10_000);
      const linkId = await linkIdOf("cn-race-4162-v");
      const recorded = await reRecord(linkId, 10_000);
      // A recount before it runs: the payment-wide gap is now nothing.
      await inbound({ creditNoteID: "cn-race-4162-l", creditNoteNumber: "CN-l", status: "AUTHORISED", total: 100, appliedAmount: 0, remainingCredit: 100, allocations: [], payments: [] });
      expect(await raiseQueuedNote(recorded.noteOperationId, { asOlderWorker: true })).toEqual([]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: recorded.noteOperationId }, select: { xeroObjectId: true } })).toEqual({ xeroObjectId: "cn-race-4162-l" });

      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([
        expect.objectContaining({ voidedCreditNoteId: "cn-race-4162-v", flag: "note-failed", retryable: true }),
      ]);
      const retried = await retry.retryBankTransferRefundReRecord({ linkId, actingMemberId: OFFICER_ID });
      expect(await raiseQueuedNote(retried.noteOperationId, { noteId: "cn-race-4162-n" })).toEqual([
        { key: `payment:${PAYMENT_ID}:refund-credit-note:re-record:${recorded.resolutionId}:0:v3`, amount: 100 },
      ]);
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    /** A second capture row on the payment, and card refunds Stripe recorded against one. */
    async function twoCaptureRows(second: "INTERNET_BANKING" | "STRIPE") {
      await prisma.payment.create({
        data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: INVOICE_ID },
      });
      await prisma.paymentTransaction.create({
        data: { id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: 10_000, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: `${TXN_ID}-2`, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: second, amountCents: 10_000, status: "SUCCEEDED", createdAt: new Date("2026-06-02T00:00:00.000Z"),
          ...(second === "STRIPE" ? { stripePaymentIntentId: "pi_race_4162" } : {}),
        },
      });
    }

    async function rowRefunds() {
      const rows = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, select: { id: true, refundedAmountCents: true } });
      return Object.fromEntries(rows.map((row) => [row.id, row.refundedAmountCents]));
    }

    it("MUTATION: the unwind takes back in the reverse of the fill's order (bank and bank)", async () => {
      await twoCaptureRows("INTERNET_BANKING");
      const { applyLocalRefundAllocation, unwindLocalRefundAllocation } = await import("@/lib/payment-transactions");
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 5_000 });
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 10_000 });
      expect(await rowRefunds()).toEqual({ [TXN_ID]: 5_000, [`${TXN_ID}-2`]: 10_000 });

      await unwindLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 10_000 });

      // The second hand-back filled the newer row, then the older: taken back older first.
      expect(await rowRefunds()).toEqual({ [TXN_ID]: 0, [`${TXN_ID}-2`]: 5_000 });
    });

    it("MUTATION: the unwind never takes a card row below the refunds Stripe recorded against it", async () => {
      await twoCaptureRows("STRIPE");
      await prisma.paymentRefund.create({
        data: { paymentId: PAYMENT_ID, paymentTransactionId: `${TXN_ID}-2`, stripeRefundId: "re_race_4162", stripePaymentIntentId: "pi_race_4162", amountCents: 4_000, currency: "nzd", status: "succeeded" },
      });
      await prisma.paymentTransaction.update({ where: { id: `${TXN_ID}-2` }, data: { refundedAmountCents: 4_000, status: "PARTIALLY_REFUNDED" } });
      const { applyLocalRefundAllocation, unwindLocalRefundAllocation } = await import("@/lib/payment-transactions");
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 12_000 });
      expect(await rowRefunds()).toEqual({ [TXN_ID]: 6_000, [`${TXN_ID}-2`]: 10_000 });

      await unwindLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 12_000 });

      expect(await rowRefunds()).toEqual({ [TXN_ID]: 0, [`${TXN_ID}-2`]: 4_000 });

      // A bank hand-back placed on the card row only: what Stripe refunded there is never taken back.
      await applyLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 6_000, preferTransactionIds: [`${TXN_ID}-2`] });
      expect(await rowRefunds()).toEqual({ [TXN_ID]: 0, [`${TXN_ID}-2`]: 10_000 });
      const { RefundUnwindExceedsAllocatedError } = await import("@/lib/payment-transactions");
      await expect(unwindLocalRefundAllocation({ paymentId: PAYMENT_ID, amountCents: 8_000 })).rejects.toBeInstanceOf(RefundUnwindExceedsAllocatedError);
      expect(await rowRefunds()).toEqual({ [TXN_ID]: 0, [`${TXN_ID}-2`]: 10_000 });
    });

    it("confirm replaced in Xero moves nothing: the item leaves the list with the reason", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const before = await money();

      const result = await resolution.confirmBankTransferRefundCancelled({
        linkId: await linkIdOf("cn-race-4162-v"), reason: "replaced-in-xero", expectedAmountCents: PAID_CENTS, note: "CN-900 raised by hand", actingMemberId: OFFICER_ID,
      });

      expect(result).toMatchObject({ unwoundCents: 0, reversedLedgerLineId: null });
      expect(await money()).toEqual(before);
      expect(await prisma.bankRefundVoidResolution.findFirst({ where: { paymentId: PAYMENT_ID } })).toMatchObject({
        outcome: "CONFIRMED_REPLACED_IN_XERO", note: "CN-900 raised by hand",
      });
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    it("an inbound recount inside the window lowers the total again, the note is still raised in full, and the total corrects when it lands", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-live", 10_000, { perDelta: true });
      await handBackNoted("cn-race-4162-v", 10_000);
      await voidLongAgo("cn-race-4162-v", 10_000);
      expect((await money()).payment.refundedAmountCents).toBe(10_000);
      const result = await reRecord(await linkIdOf("cn-race-4162-v"), 10_000);
      expect(result.restoredCents).toBe(10_000);
      expect((await money()).payment.refundedAmountCents).toBe(PAID_CENTS);

      // A redelivery of the void changes nothing.
      await inbound(voidedNote("cn-race-4162-v", 10_000));
      expect((await money()).payment.refundedAmountCents).toBe(PAID_CENTS);
      // Another note's inbound sync before the fresh note is linked: the
      // recount reads only live notes, so the restored refund drops out again.
      const liveNote = { creditNoteID: "cn-race-4162-live", creditNoteNumber: "CN-live", status: "AUTHORISED", total: 100, appliedAmount: 0, remainingCredit: 100, allocations: [], payments: [] };
      await inbound(liveNote);
      expect((await money()).payment.refundedAmountCents).toBe(10_000);

      // Sized from its record, the note is still raised for the whole voided amount.
      const sent = await raiseQueuedNote(result.noteOperationId);
      expect(sent).toEqual([expect.objectContaining({ amount: 100 })]);

      // The fresh note's own inbound sync counts it, and the total is whole again.
      await inbound({ creditNoteID: "cn-race-4162-fresh", creditNoteNumber: "CN-cn-race-4162-fresh", status: "AUTHORISED", total: 100, appliedAmount: 0, remainingCredit: 100, allocations: [], payments: [] });
      expect((await money()).payment.refundedAmountCents).toBe(PAID_CENTS);
    });

    it("a recount racing an uncommitted record-again loses its compare-and-set, recounts from what committed, and leaves the link-derived total", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-live", 10_000, { perDelta: true });
      await handBackNoted("cn-race-4162-v", 10_000);
      await voidLongAgo("cn-race-4162-v", 10_000);

      // Hold the record-again inside its transaction, after its total write.
      const outbox = await import("@/lib/xero-operation-outbox");
      const realEnqueue = outbox.enqueueXeroRefundCreditNoteOperation;
      let release!: () => void;
      const mayFinish = new Promise<void>((resolve) => (release = resolve));
      let markHeld!: () => void;
      const held = new Promise<void>((resolve) => (markHeld = resolve));
      vi.spyOn(outbox, "enqueueXeroRefundCreditNoteOperation").mockImplementation((async (...args: Parameters<typeof realEnqueue>) => {
        markHeld();
        await mayFinish;
        return realEnqueue(...args);
      }) as never);
      const claims: number[] = [];
      const realUpdateMany = prisma.payment.updateMany.bind(prisma.payment);
      vi.spyOn(prisma.payment, "updateMany").mockImplementation((async (args: Parameters<typeof realUpdateMany>[0]) => {
        const result = await realUpdateMany(args);
        if ((args.where as { updatedAt?: unknown } | undefined)?.updatedAt !== undefined) claims.push(result.count);
        return result;
      }) as never);

      const recording = reRecord(await linkIdOf("cn-race-4162-v"), 10_000);
      await held;
      // Xero now reports the live note at $50: the recount reads the committed
      // total ($100) and computes $50, then waits on the record-again's row.
      const recount = inbound({ creditNoteID: "cn-race-4162-live", creditNoteNumber: "CN-live", status: "AUTHORISED", total: 50, appliedAmount: 0, remainingCredit: 50, allocations: [], payments: [] });
      // Long enough for the recount to reach its write and queue on the row.
      const startedNs = process.hrtime.bigint();
      while (realElapsedMs(startedNs) < 1_500) await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await recording;
      await recount;
      vi.restoreAllMocks();

      // Lost once to the record-again's write, then re-ran from what committed.
      expect(claims).toEqual([0, 1]);
      expect((await money()).payment.refundedAmountCents).toBe(5_000);
    });

    it("#4161's heal defers while a record-again holds the Payment row, and the list shows a healed note only", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", 10_000);
      await handBackNoted("cn-race-4162-old", 10_000, { perDelta: true });
      await voidLongAgo("cn-race-4162-v", 10_000);
      // The pre-#4091 shape on the second note: Xero's VOIDED merged, the mirror still active.
      await prisma.xeroObjectLink.updateMany({
        where: { localId: PAYMENT_ID, xeroObjectId: "cn-race-4162-old" },
        data: { metadata: { amountCents: 10_000, watermarkCents: 10_000, perDelta: true, status: "VOIDED", total: 100 } },
      });
      const listed = async () => (await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID).map((item) => item.voidedCreditNoteId);
      expect(await listed()).toEqual(["cn-race-4162-v"]);

      // Hold the record-again inside its transaction, after its locks.
      const outbox = await import("@/lib/xero-operation-outbox");
      const realEnqueue = outbox.enqueueXeroRefundCreditNoteOperation;
      let release!: () => void;
      const mayFinish = new Promise<void>((resolve) => (release = resolve));
      let markHeld!: () => void;
      const held = new Promise<void>((resolve) => (markHeld = resolve));
      vi.spyOn(outbox, "enqueueXeroRefundCreditNoteOperation").mockImplementation((async (...args: Parameters<typeof realEnqueue>) => {
        markHeld();
        await mayFinish;
        return realEnqueue(...args);
      }) as never);
      const recording = reRecord(await linkIdOf("cn-race-4162-v"), 10_000);
      await held;

      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      const oldLinkId = await linkIdOf("cn-race-4162-old");
      const deferred = await cleanupStaleCanonicalXeroObjectLinks();
      expect(deferred.deferredRefundNoteHealLinkIds).toContain(oldLinkId);
      expect(await prisma.xeroObjectLink.findUniqueOrThrow({ where: { id: oldLinkId }, select: { active: true } })).toEqual({ active: true });

      release();
      await recording;
      vi.restoreAllMocks();
      // An active voided mirror is the drift report's until it is healed.
      expect(await listed()).toEqual([]);
    });

    it("a draining older worker running a record-again row raises the voided amount, never more, under a key that never replays the voided note's", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const result = await reRecord(await linkIdOf("cn-race-4162-v"));

      const sent = await raiseQueuedNote(result.noteOperationId, { asOlderWorker: true });

      expect(sent).toHaveLength(1);
      expect(sent[0]!.amount).toBe(PAID_CENTS / 100);
      expect(sent[0]!.key).not.toBe(`payment:${PAYMENT_ID}:refund-credit-note:${PAID_CENTS}:v2`);
      expect(sent[0]!.key).toContain("after-void");
      // The record-again still finds its own row by the id it queued, though the
      // older worker rewrote the payload without `reRecordId`: it has landed.
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
    });

    it("a record-again whose note failed comes back flagged, and one whose note was voided again comes back as that note's own item", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const result = await reRecord(await linkIdOf("cn-race-4162-v"));
      await prisma.xeroSyncOperation.update({ where: { id: result.noteOperationId }, data: { status: "FAILED", replayable: true } });

      const listed = async () => (await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID);
      expect(await listed()).toEqual([
        expect.objectContaining({ voidedCreditNoteId: "cn-race-4162-v", flag: "note-failed", answerable: false, retryable: true }),
      ]);

      await prisma.xeroSyncOperation.update({ where: { id: result.noteOperationId }, data: { status: "PENDING" } });
      await raiseQueuedNote(result.noteOperationId);
      await voidLongAgo("cn-race-4162-fresh", PAID_CENTS);
      expect(await listed()).toEqual([
        expect.objectContaining({ voidedCreditNoteId: "cn-race-4162-fresh", flag: "voided-again", reRecordOf: "CN-cn-race-4162-v", answerable: true }),
      ]);
    });

    it("Retry: a record-again whose note failed after Xero raised it is queued again under the same key, and exactly one note results", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const linkId = await linkIdOf("cn-race-4162-v");
      const recorded = await reRecord(linkId);

      // A Xero that keeps every note it raised by key and replays a key it has
      // seen. The first attempt raises the note and its answer is lost.
      const raised = new Map<string, string>();
      let loseTheAnswer = true;
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            if (!raised.has(key!)) raised.set(key!, `cn-race-4162-retry-${raised.size + 1}`);
            if (loseTheAnswer) {
              loseTheAnswer = false;
              throw new Error("socket hang up");
            }
            const id = raised.get(key!)!;
            return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${id}`, total, remainingCredit: total, status: "AUTHORISED", payments: [] }] } };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4162" } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4162");
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (opts: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
        opts.run({ contactId: opts.currentContactId })) as never);
      vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4162" });
      const run = async (operationId: string) => {
        const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { requestPayload: true } });
        const payload = row.requestPayload as { refundAmountCents: number; watermarkCents: number; reRecordId?: string };
        await createXeroCreditNote(PAYMENT_ID, payload.refundAmountCents, {
          syncOperationId: operationId, watermarkCents: payload.watermarkCents, refundMethod: "internet-banking", reRecordId: payload.reRecordId,
        }).catch(() => undefined);
      };

      await run(recorded.noteOperationId);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: recorded.noteOperationId }, select: { status: true } })).toEqual({ status: "FAILED" });
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([
        expect.objectContaining({ flag: "note-failed", retryable: true }),
      ]);

      const retried = await retry.retryBankTransferRefundReRecord({ linkId, note: "Xero was down", actingMemberId: OFFICER_ID });
      expect(retried.retiredOperationIds).toEqual([recorded.noteOperationId]);
      // The failed attempt can no longer run: only the new row can mint.
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: recorded.noteOperationId }, select: { replayable: true } })).toEqual({ replayable: false });
      // A double click: the second reads the note on its way and queues nothing.
      await expect(retry.retryBankTransferRefundReRecord({ linkId, actingMemberId: OFFICER_ID })).rejects.toMatchObject({ status: 409 });
      await run(retried.noteOperationId);

      // MUTATION: the same resolution key, so Xero handed back the note the lost attempt raised.
      expect([...raised.keys()]).toEqual([`payment:${PAYMENT_ID}:refund-credit-note:re-record:${recorded.resolutionId}:0:v3`]);
      const notes = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE", active: true }, select: { xeroObjectId: true },
      });
      expect(notes).toEqual([{ xeroObjectId: "cn-race-4162-retry-1" }]);
      expect(await prisma.auditLog.count({ where: { action: "booking-payment.bank-refund.re-record-retried", entityId: recorded.resolutionId } })).toBe(1);
      expect((await report.listBankRefundVoids()).filter((item) => item.paymentId === PAYMENT_ID)).toEqual([]);
      vi.restoreAllMocks();
    });

    it("refuses a record-again while another refund note could still mint, and a confirm at an amount that moved", async () => {
      await paidBankTransfer();
      await handBackNoted("cn-race-4162-v", PAID_CENTS);
      await voidLongAgo("cn-race-4162-v", PAID_CENTS);
      const linkId = await linkIdOf("cn-race-4162-v");
      const running = await prisma.xeroSyncOperation.create({
        data: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID, status: "RUNNING" },
      });
      await expect(reRecord(linkId)).rejects.toMatchObject({ status: 409 });
      await prisma.xeroSyncOperation.delete({ where: { id: running.id } });
      await expect(
        resolution.confirmBankTransferRefundCancelled({ linkId, reason: "cancelled", expectedAmountCents: PAID_CENTS - 1, note: "x", actingMemberId: OFFICER_ID }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await prisma.bankRefundVoidResolution.count({ where: { paymentId: PAYMENT_ID } })).toBe(0);
      expect((await money()).txn.refundedAmountCents).toBe(PAID_CENTS);
    });
  },
);
