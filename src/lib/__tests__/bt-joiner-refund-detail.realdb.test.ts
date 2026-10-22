/**
 * Real-PostgreSQL proof of #4290: a bank-transfer group joiner's refund is held
 * by the #4162 floor (`INV-ADDPAY-021`) like any other bank-transfer refund.
 *
 * When an organiser cancels a group paid by ONE Internet Banking settlement,
 * the real group cancel (`settleGroupBookingOnOrganiserCancel`) records each
 * joiner's refund on the joiner's own payment - `refundedAmountCents` and a
 * `GROUP_SETTLEMENT` `BANK_REFUND` line on the joiner's booking ledger - but on
 * NO charge row (`PaymentTransaction`): the settle never wrote one, because the
 * group settlement posts the joiner's share itself (#3854) and a charge row
 * would post a second receipt. The floor used to read only charge rows, so a
 * joiner's detail read 0 and the recount followed Xero all the way down with no
 * alert. Here, driven through the real settle, the real cancel and the real
 * inbound reconcile (Xero faked, no provider call):
 *
 * - the cancel's record: the joiner's refund on its payment and its line, and
 *   no charge row;
 * - the void: Xero voids the joiner's canonical note, and the inbound recount
 *   keeps the refund; while the void waits for the nightly follow-up it is
 *   logged, not alerted, and the follow-up lists it for a person (no hand-back
 *   line of its own to undo);
 * - a short note: Xero's live note records less than the joiner's refund, as an
 *   absorbed later refund would leave it; the recount keeps the refund and
 *   raises the divergence alert;
 * - a later refund on the joiner's payment (an approved appeal's hand-back)
 *   cannot be recorded there at all - its completion is refused, so nothing
 *   is absorbed into the joiner's note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4290-`
 * fixtures.
 */
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4290";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const D1 = new Date("2027-09-01T00:00:00.000Z");
const D2 = new Date("2027-09-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-03T00:00:00.000Z");
const NIGHT_CENTS = 2_250;
const CHILD_CENTS = 2 * NIGHT_CENTS;
/** The lodge's one tier: half back, no fee. */
const JOINER_REFUND_CENTS = CHILD_CENTS / 2;

const GROUP_KEYS = ["void", "short", "later"] as const;
type GroupKey = (typeof GROUP_KEYS)[number];
type Group = { organiser: string; group: string; settlement: string; invoice: string; children: [string, string] };
const groupOf = (key: GroupKey): Group => ({
  organiser: `${P}-${key}-organiser`,
  group: `${P}-${key}-group`,
  settlement: `${P}-${key}-settlement`,
  invoice: `${P}-${key}-invoice`,
  children: [`${P}-${key}-child-1`, `${P}-${key}-child-2`],
});
const GROUPS = GROUP_KEYS.map(groupOf);
const ALL_BOOKINGS = GROUPS.flatMap((g) => [g.organiser, ...g.children]);

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];

(RUN ? describe : describe.skip)(
  "a bank-transfer group joiner's refund is held by the #4162 floor - real PostgreSQL (#4290)",
  { timeout: 120_000 },
  () => {
    async function deleteFixtures() {
      const payments = await prisma.payment.findMany({ where: { bookingId: { in: ALL_BOOKINGS } }, select: { id: true } });
      const paymentIds = payments.map((payment) => payment.id);
      const settlementIds = GROUPS.map((g) => g.settlement);
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [...paymentIds, ...ALL_BOOKINGS, ...settlementIds] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [...paymentIds, ...ALL_BOOKINGS, ...settlementIds] } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.refundRequest.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.auditLog.deleteMany({ where: { targetId: { in: ALL_BOOKINGS } } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: { in: paymentIds } } });
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      await prisma.groupBookingSettlement.deleteMany({ where: { id: { in: settlementIds } } });
      await prisma.groupBooking.deleteMany({ where: { id: { in: GROUPS.map((g) => g.group) } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: { in: ALL_BOOKINGS } } });
      await prisma.booking.deleteMany({ where: { id: { in: GROUPS.flatMap((g) => g.children) } } });
      await prisma.booking.deleteMany({ where: { id: { in: GROUPS.map((g) => g.organiser) } } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    /**
     * An organiser-pays group of two joiners on one Internet Banking settlement,
     * settled by the real inbound reconcile of its paid invoice and then
     * cancelled by its organiser through the real group cancel.
     */
    async function settledThenCancelled(g: Group) {
      const stay = { memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, totalPriceCents: CHILD_CENTS, finalPriceCents: CHILD_CENTS };
      await prisma.booking.create({ data: { ...stay, id: g.organiser, status: "PAID" } });
      await prisma.groupBooking.create({
        data: { id: g.group, organiserBookingId: g.organiser, organiserMemberId: MEMBER_ID, joinCode: g.group, paymentMode: "ORGANISER_PAYS" },
      });
      await prisma.groupBookingSettlement.create({
        data: { id: g.settlement, groupBookingId: g.group, amountCents: CHILD_CENTS * g.children.length, status: "PENDING", source: "INTERNET_BANKING", xeroInvoiceId: g.invoice },
      });
      for (const id of g.children) {
        await prisma.booking.create({ data: { ...stay, id, status: "CONFIRMED", parentBookingId: g.organiser, organiserSettled: true } });
        await prisma.bookingGuest.create({
          data: {
            id: `${id}-guest`,
            bookingId: id,
            firstName: "Joiner",
            lastName: id,
            ageTier: "ADULT",
            isMember: true,
            stayStart: D1,
            stayEnd: CHECK_OUT,
            priceCents: CHILD_CENTS,
            nights: {
              create: [
                { stayDate: D1, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
                { stayDate: D2, priceCents: NIGHT_CENTS, priceSource: "SOLD" },
              ],
            },
          },
        });
      }
      const { syncGroupSettlementForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
      const invoice = { invoiceID: g.invoice, status: "PAID", amountPaid: (CHILD_CENTS * g.children.length) / 100 } as unknown as Invoice;
      expect(await syncGroupSettlementForPaidInvoice(invoice, CLUB_FORMAT_TEST)).toMatchObject({ settledGroupSettlements: 1, settledChildBookings: 2 });
      const { settleGroupBookingOnOrganiserCancel } = await import("@/lib/group-cancel");
      await settleGroupBookingOnOrganiserCancel(g.organiser, MEMBER_ID, "127.0.0.1", CLUB_FORMAT_TEST);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: g.children[0] }, select: { id: true } });
      return { childId: g.children[0], paymentId: payment.id };
    }

    /**
     * The joiner's refund note, as the outbox records a note Xero raised for the
     * cancel's queued operation: the row succeeded, its link and the pointer.
     */
    async function noteRaised(paymentId: string, noteId: string) {
      const operation = await prisma.xeroSyncOperation.findFirstOrThrow({
        where: { localModel: "Payment", localId: paymentId, entityType: "CREDIT_NOTE" },
        select: { id: true },
      });
      await prisma.xeroSyncOperation.update({
        where: { id: operation.id },
        data: { status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`, completedAt: new Date("2026-06-01T00:00:00.000Z") },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId, xeroObjectNumber: `CN-${noteId}`,
          role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: JOINER_REFUND_CENTS, watermarkCents: JOINER_REFUND_CENTS, status: "AUTHORISED", total: JOINER_REFUND_CENTS / 100 },
        },
      });
      await prisma.payment.update({ where: { id: paymentId }, data: { xeroRefundCreditNoteId: noteId } });
    }

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function inbound(note: Record<string, unknown>) {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4290" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        await reconcileXeroCreditNote(note.creditNoteID as string);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    function creditNote(noteId: string, status: "VOIDED" | "AUTHORISED", cents: number) {
      return { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status, total: cents / 100, appliedAmount: 0, remainingCredit: cents / 100, allocations: [], payments: [] };
    }

    async function joinerRecord(paymentId: string, childId: string) {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { refundedAmountCents: true, status: true, source: true } });
      const chargeRows = await prisma.paymentTransaction.count({ where: { paymentId } });
      const refundLines = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: childId, kind: "BANK_REFUND" },
        select: { amountCents: true, anchorKind: true, postingKey: true, reversesLineId: true },
      });
      return { payment, chargeRows, refundLines };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Bank-transfer group joiner refund detail (#4290)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Joiner", lastName: "Detail", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4290 Lodge", slug: P } });
      await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 0 } });
    }, 120_000);

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 120_000);

    it("probe and MUTATION (joiner detail): Xero voids the joiner's note; the recount keeps the refund, logs it while the follow-up waits, and the follow-up lists it for a person", async () => {
      const g = groupOf("void");
      const { childId, paymentId } = await settledThenCancelled(g);
      const settlementLine = `group-settlement:${g.settlement}:refund:${childId}`;
      const before = await joinerRecord(paymentId, childId);
      // (a) The cancel's record: the refund on the payment and its line - and no charge row.
      expect(before).toEqual({
        payment: { refundedAmountCents: JOINER_REFUND_CENTS, status: "PARTIALLY_REFUNDED", source: "INTERNET_BANKING" },
        chargeRows: 0,
        refundLines: [{ amountCents: -JOINER_REFUND_CENTS, anchorKind: "GROUP_SETTLEMENT", postingKey: settlementLine, reversesLineId: null }],
      });
      await noteRaised(paymentId, `${P}-void-note`);

      const alerts = await import("@/lib/xero-error-alert");
      const alert = vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      await inbound(creditNote(`${P}-void-note`, "VOIDED", JOINER_REFUND_CENTS));

      // (b) MUTATION (drop the joiner's line from the detail): before #4290 the
      // total fell to 0 and the payment read SUCCEEDED, with no alert.
      expect(await joinerRecord(paymentId, childId)).toEqual(before);
      // The void waits for the nightly follow-up, which explains it: logged, not alerted.
      expect(alert).not.toHaveBeenCalled();
      const link = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: paymentId, xeroObjectId: `${P}-void-note` }, select: { id: true, active: true } });
      expect(link.active).toBe(false);

      // The follow-up has no hand-back line of the joiner's own to undo (the
      // line is the settlement's), so a person answers it on Stuck States.
      const scan = await import("@/lib/bank-refund-void-scan");
      expect(await scan.classifyVoidedBankRefundNote(prisma as never, link.id)).toMatchObject({
        classification: { kind: "unmatched", reason: "no-line", amountCents: JOINER_REFUND_CENTS },
      });
    });

    it("MUTATION (joiner detail): a live note for less than the joiner's refund - an absorbed later refund's shape - keeps the refund and raises the divergence alert", async () => {
      const g = groupOf("short");
      const { childId, paymentId } = await settledThenCancelled(g);
      await noteRaised(paymentId, `${P}-short-note`);
      const before = await joinerRecord(paymentId, childId);

      const alerts = await import("@/lib/xero-error-alert");
      const alert = vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      await inbound(creditNote(`${P}-short-note`, "AUTHORISED", JOINER_REFUND_CENTS / 2));

      expect(await joinerRecord(paymentId, childId)).toEqual(before);
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: "refund-ledger-divergence", operation: `inbound-credit-note-repair:${P}-short-note` }),
      );
    });

    it("a later refund on the joiner's payment is never recorded there: its hand-back's completion is refused, so nothing is absorbed into the joiner's note", async () => {
      const g = groupOf("later");
      const { childId, paymentId } = await settledThenCancelled(g);
      await noteRaised(paymentId, `${P}-later-note`);
      const before = await joinerRecord(paymentId, childId);
      const request = await prisma.refundRequest.create({
        data: { bookingId: childId, memberId: MEMBER_ID, reason: P, requestedAmountCents: 500, status: "APPROVED", approvedAmountCents: 500 },
        select: { id: true },
      });
      const { raiseRefundRequestHandBack } = await import("@/lib/edit-refund-hand-back");
      await prisma.$transaction((tx) => raiseRefundRequestHandBack(tx, { bookingId: childId, paymentId, refundRequestId: request.id, amountCents: 500 }));
      const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: childId, paymentId }, select: { id: true } });
      const operationsBefore = await prisma.xeroSyncOperation.count({ where: { localId: paymentId } });

      const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
      await expect(
        resolveManualRefundTask(
          { taskId: task.id, resolution: "completed", note: null, actingMemberId: OFFICER_ID, confirmedAmountCents: null, direction: null, recordedNightPrices: null },
          CLUB_FORMAT_TEST,
        ),
      ).rejects.toThrow("more than was ever captured on this payment");

      expect(await joinerRecord(paymentId, childId)).toEqual(before);
      expect(await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).toEqual({ status: "OPEN" });
      expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId } })).toBe(operationsBefore);
    });
  },
);
