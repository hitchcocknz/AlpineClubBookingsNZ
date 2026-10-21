/**
 * Real-PostgreSQL proof of #3949 (`INV-PAY-136`; owner decisions on #3949, 15
 * and 21 Oct 2026): an edit's or an approved appeal's bank-transfer refund on a
 * joiner's booking the group organiser paid for by internet banking is paid back
 * to the ORGANISER and recorded on the child's payment mirror - the way the
 * group cancel records its own refunds on a child - never through
 * `applyLocalRefundAllocation`, which finds no captured transaction behind the
 * mirror and used to refuse every amount.
 *
 * Driven through the real writers: the group settle (the paid combined
 * invoice's inbound reconcile), the edit's ledger rows and its hand-back raiser,
 * the completion door (`resolveManualRefundTask`), the reopen door, and the real
 * organiser cancel, including a re-drive of one interrupted after its plan was
 * frozen (the reaper's resume path calls the same function). After each step the
 * booking-ledger census reads the child as agreeing - nothing left in flight.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-3949-`
 * fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BookingLedgerCensusReport } from "@/lib/booking-ledger-projection-census-report";
import { cleanHistories, historyNames, postHistoryEdit, seedHistoryFixtures } from "@/lib/__tests__/support/booking-ledger-history";
import {
  cancelGroupHistory,
  createGroupHistory,
  GROUP_CHILD_CENTS,
  GROUP_NIGHT_CENTS,
  groupHistory,
  settleGroupHistory,
  type GroupHistory,
} from "@/lib/__tests__/support/booking-ledger-group-history";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const PREFIX = "race-3949-";
const NAMES = historyNames(PREFIX);
const D2 = new Date("2027-10-02T00:00:00.000Z");
/** The edit's reduction: one night $15 cheaper. */
const EDIT_CENTS = 1_500;

let prisma: PrismaClient;
let resolution: typeof import("@/lib/manual-refund-task-resolution");
let reopenDoor: typeof import("@/lib/manual-refund-task-reopen");
let rules: typeof import("@/lib/manual-refund-task-settlement-rules");
let censusStore: typeof import("@/lib/booking-ledger-projection-census-store");

async function census(): Promise<BookingLedgerCensusReport> {
  return censusStore.censusBookingLedgerProjection(prisma);
}

/** Everything the census says about one booking. */
function about(report: BookingLedgerCensusReport, bookingId: string) {
  return {
    disagreements: report.disagreements.filter((row) => row.bookingId === bookingId),
    coverage: Object.entries(report.coverage).flatMap(([kind, ids]) => (ids.includes(bookingId) ? [kind] : [])),
    integrity: report.integrity.findings.filter((finding) => finding.bookingId === bookingId).map((finding) => finding.kind),
    classes: Object.entries(report.classes).flatMap(([name, entry]) =>
      entry.instances.filter((instance) => instance.bookingId === bookingId).map((instance) => `${name}:${instance.identity}`),
    ),
  };
}
const NOTHING = { disagreements: [], coverage: [], integrity: [], classes: [] };
/** A hand-back paid back by bank transfer reads as every such completion does: its BANK_REFUND matched to its task. */
const PAID_BACK = { ...NOTHING, classes: ["REFUND_MIRROR_HAND_BACK:REFUNDED"] };

async function settledGroup(key: string): Promise<GroupHistory> {
  const g = groupHistory(PREFIX, key, "INTERNET_BANKING", 2);
  await createGroupHistory(prisma, NAMES, g);
  await settleGroupHistory(g);
  return g;
}

/** The edit door's own rows and lines, then its hand-back raiser on the child as it stands (#3827). */
async function editHandBack(childId: string, key: string): Promise<string> {
  const modificationId = `${childId}-${key}`;
  await postHistoryEdit(prisma, NAMES, childId, modificationId, {
    reprice: { guestId: `${childId}-g1`, stayDate: D2, priceCents: GROUP_NIGHT_CENTS - EDIT_CENTS },
    changeFeeCents: 0,
  });
  const { raiseEditRefundHandBackIfOwed } = await import("@/lib/edit-refund-hand-back");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: childId }, include: { payment: true } });
    expect(
      await raiseEditRefundHandBackIfOwed(tx, {
        bookingId: childId,
        paymentId: booking.payment!.id,
        bookingModificationId: modificationId,
        adjusted: { refundAmountCents: EDIT_CENTS, hasSucceededPayment: false },
        editLabel: "date change",
        booking,
      }),
    ).toBe(true);
  });
  const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: `edit-refund-hand-back:${modificationId}` }, select: { id: true, reason: true } });
  // The officer is told whose account the money goes to (owner decision, 21 Oct 2026).
  expect(task.reason).toContain("to the group organiser by bank transfer");
  return task.id;
}

/** An approved appeal's bank-transfer part, raised by the approval's own writer under lock(1). */
async function appealHandBack(childId: string, cents: number): Promise<string> {
  const request = await prisma.refundRequest.create({
    data: { bookingId: childId, memberId: NAMES.memberId, reason: "race 3949 appeal", requestedAmountCents: cents, status: "APPROVED", approvedAmountCents: cents, reviewedBy: NAMES.officerId, reviewedAt: new Date("2026-06-20T00:00:00.000Z") },
    select: { id: true },
  });
  const { raiseRefundRequestHandBack } = await import("@/lib/edit-refund-hand-back");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: childId }, include: { payment: true } });
    expect(await raiseRefundRequestHandBack(tx, { bookingId: childId, paymentId: booking.payment!.id, refundRequestId: request.id, amountCents: cents, booking })).toBe(1);
  });
  const task = await prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: `refund-request-hand-back:${request.id}` }, select: { id: true, reason: true } });
  expect(task.reason).toContain("to the group organiser by bank transfer");
  return task.id;
}

const complete = (taskId: string) =>
  resolution.resolveManualRefundTask(
    { taskId, resolution: "completed", note: null, actingMemberId: NAMES.officerId, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null },
    CLUB_FORMAT_TEST,
  );
const dismiss = (taskId: string) =>
  resolution.resolveManualRefundTask({ taskId, resolution: "dismissed", note: "settled another way", actingMemberId: NAMES.officerId, recordedNightPrices: null }, CLUB_FORMAT_TEST);
const reopen = (taskId: string) => reopenDoor.reopenManualRefundTask({ taskId, actingMemberId: NAMES.officerId, note: "dismissed by mistake" });

const payment = (bookingId: string) =>
  prisma.payment.findUniqueOrThrow({ where: { bookingId }, select: { status: true, amountCents: true, refundedAmountCents: true } });
const settlementStatus = async (g: GroupHistory) => (await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement } })).status;
const money = async (bookingId: string) =>
  (await prisma.bookingLedgerLine.findMany({ where: { bookingId, reversesLineId: null }, orderBy: { id: "asc" }, select: { kind: true, amountCents: true, anchorKind: true } }))
    .filter((line) => ["BANK_RECEIPT", "BANK_REFUND", "CANCELLATION_FEE"].includes(line.kind))
    .map((line) => `${line.kind}:${line.anchorKind}:${line.amountCents}`)
    .sort();

(RUN ? describe : describe.skip)("#3949: a hand-back on a joiner the organiser paid for by internet banking, against PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "IB group child hand-back (#3949)");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    resolution = await import("@/lib/manual-refund-task-resolution");
    reopenDoor = await import("@/lib/manual-refund-task-reopen");
    rules = await import("@/lib/manual-refund-task-settlement-rules");
    censusStore = await import("@/lib/booking-ledger-projection-census-store");
    await cleanHistories(prisma, PREFIX);
    await seedHistoryFixtures(prisma, PREFIX);
  }, 300_000);

  afterAll(async () => {
    if (!prisma) return;
    await cleanHistories(prisma, PREFIX);
  }, 120_000);

  it("an edit's hand-back on a live child completes onto its mirror; the group's settlement is untouched and nothing is left in flight", async () => {
    const g = await settledGroup("live-edit");
    const [edited] = g.children;
    const taskId = await editHandBack(edited!, "m1");
    // Open on a live booking, it is owed and nothing disagrees.
    expect(about(await census(), edited!)).toEqual(NOTHING);

    await complete(taskId);

    expect(await payment(edited!)).toEqual({ status: "PARTIALLY_REFUNDED", amountCents: GROUP_CHILD_CENTS, refundedAmountCents: EDIT_CENTS });
    expect(await settlementStatus(g)).toBe("SUCCEEDED");
    expect(await money(edited!)).toEqual([`BANK_RECEIPT:GROUP_SETTLEMENT:${GROUP_CHILD_CENTS}`, `BANK_REFUND:REVIEW_TASK:${-EDIT_CENTS}`]);
    const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: edited!, type: "REFUNDED" }, select: { amountCents: true, snapshot: true } });
    expect(event).toEqual({ amountCents: EDIT_CENTS, snapshot: { kind: "edit_refund_hand_back_completed", manualRefundTaskId: taskId } });
    expect(about(await census(), edited!)).toEqual(PAID_BACK);
    // COMPLETED is terminal: neither a second completion nor a reopen moves it again.
    await expect(complete(taskId)).rejects.toMatchObject({ status: 409 });
    await expect(reopen(taskId)).rejects.toMatchObject({ status: 409 });
    expect((await payment(edited!)).refundedAmountCents).toBe(EDIT_CENTS);
  }, 300_000);

  it("an edit's: dismissed and reopened on a live child; after the group cancel a dismissal is refused naming the organiser, and paying it closes it", async () => {
    const g = await settledGroup("cancel-edit");
    const [edited, other] = g.children;
    const live = await editHandBack(edited!, "m1");
    await dismiss(live);
    await reopen(live);
    expect((await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: live } })).status).toBe("OPEN");

    await cancelGroupHistory(NAMES, g);
    // The plan halves each child's refundable base, the edited one net of the $15 still promised.
    const plan = (await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement } })).refundPlan;
    expect(plan).toEqual({ [edited!]: (GROUP_CHILD_CENTS - EDIT_CENTS) / 2, [other!]: GROUP_CHILD_CENTS / 2 });
    await expect(dismiss(live)).rejects.toMatchObject({ status: 409, message: rules.editRefundHandBackDismissAfterCancelMessage("organiser") });
    // Until it is paid, the census holds it as money the cancel counted as going back.
    expect(about(await census(), edited!)).toEqual({ ...NOTHING, classes: ["IN_FLIGHT_HAND_BACK:PRICE"] });

    await complete(live);

    const planned = (GROUP_CHILD_CENTS - EDIT_CENTS) / 2;
    expect(await payment(edited!)).toEqual({ status: "PARTIALLY_REFUNDED", amountCents: GROUP_CHILD_CENTS, refundedAmountCents: planned + EDIT_CENTS });
    expect(await settlementStatus(g)).toBe("SUCCEEDED");
    expect(await money(edited!)).toEqual(
      [`BANK_RECEIPT:GROUP_SETTLEMENT:${GROUP_CHILD_CENTS}`, `BANK_REFUND:GROUP_SETTLEMENT:${-planned}`, `BANK_REFUND:REVIEW_TASK:${-EDIT_CENTS}`, `CANCELLATION_FEE:CANCELLATION:${GROUP_CHILD_CENTS - planned - EDIT_CENTS}`].sort(),
    );
    // Open at the cancel it was IN_FLIGHT_HAND_BACK; paid, it is the hand-back's own matched refund.
    expect(about(await census(), edited!)).toEqual(PAID_BACK);
  }, 300_000);

  it("an edit's dismissed before the group cancel cannot be reopened after it, naming the organiser", async () => {
    const g = await settledGroup("reopen-after-cancel");
    const [edited] = g.children;
    const taskId = await editHandBack(edited!, "m1");
    await dismiss(taskId);
    await cancelGroupHistory(NAMES, g);

    await expect(reopen(taskId)).rejects.toMatchObject({ status: 409, message: rules.editRefundHandBackReopenAfterCancelMessage("organiser") });
    expect((await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("DISMISSED");
  }, 300_000);

  it("an approved appeal's, after the group cancel: dismissed, reopened under its ceiling, then completed onto the mirror", async () => {
    const g = await settledGroup("appeal");
    const [child] = g.children;
    await cancelGroupHistory(NAMES, g);
    const planned = GROUP_CHILD_CENTS / 2;
    expect((await payment(child!)).refundedAmountCents).toBe(planned);
    const taskId = await appealHandBack(child!, 1_000);

    await dismiss(taskId);
    await reopen(taskId);
    await complete(taskId);

    expect(await payment(child!)).toEqual({ status: "PARTIALLY_REFUNDED", amountCents: GROUP_CHILD_CENTS, refundedAmountCents: planned + 1_000 });
    expect(await settlementStatus(g)).toBe("SUCCEEDED");
    const event = await prisma.bookingEvent.findFirstOrThrow({ where: { bookingId: child!, type: "REFUNDED", amountCents: 1_000 }, select: { snapshot: true } });
    expect(event.snapshot).toEqual({ kind: "refund_request_hand_back_completed", manualRefundTaskId: taskId });
    const found = about(await census(), child!);
    expect(found).toMatchObject({ disagreements: [], coverage: [], integrity: [] });
    expect(found.classes.filter((name) => name.startsWith("IN_FLIGHT"))).toEqual([]);
  }, 300_000);

  it("a hand-back past what the child's payment still holds is refused before the claim; the task stays OPEN", async () => {
    const g = await settledGroup("over-cap");
    const [child] = g.children;
    await cancelGroupHistory(NAMES, g);
    // The appeal's ceiling is enforced by its approval; this one is raised past it, as a stale row could be.
    const taskId = await appealHandBack(child!, GROUP_CHILD_CENTS);

    await expect(complete(taskId)).rejects.toMatchObject({ status: 400 });

    expect((await prisma.manualRefundTask.findUniqueOrThrow({ where: { id: taskId } })).status).toBe("OPEN");
    expect((await payment(child!)).refundedAmountCents).toBe(GROUP_CHILD_CENTS / 2);
  }, 300_000);

  it("a group cancel after a completed edit hand-back sizes the plan net of it and mirrors both, live and on a re-drive interrupted after its plan froze", async () => {
    for (const interrupted of [false, true]) {
      const g = await settledGroup(interrupted ? "resume-after-hand-back" : "cancel-after-hand-back");
      const [edited, other] = g.children;
      await complete(await editHandBack(edited!, "m1"));
      const planned = (GROUP_CHILD_CENTS - EDIT_CENTS) / 2;

      if (interrupted) {
        // The first run fenced the group, froze its plan and died before any child's claim; the
        // reaper's resume re-invokes the same function, which reuses the plan verbatim.
        await prisma.groupBooking.update({ where: { id: g.group }, data: { status: "CANCELLED" } });
        await prisma.groupBookingSettlement.update({ where: { id: g.settlement }, data: { refundPlan: { [edited!]: planned, [other!]: GROUP_CHILD_CENTS / 2 } } });
      }
      await cancelGroupHistory(NAMES, g);

      const plan = (await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement } })).refundPlan;
      expect(plan, `interrupted=${interrupted}`).toEqual({ [edited!]: planned, [other!]: GROUP_CHILD_CENTS / 2 });
      // Neither skipped (the hand-back's $15 does not read as "already mirrored") nor counted twice.
      expect(await payment(edited!), `interrupted=${interrupted}`).toEqual({ status: "PARTIALLY_REFUNDED", amountCents: GROUP_CHILD_CENTS, refundedAmountCents: EDIT_CENTS + planned });
      expect(await money(edited!)).toEqual(
        [`BANK_RECEIPT:GROUP_SETTLEMENT:${GROUP_CHILD_CENTS}`, `BANK_REFUND:GROUP_SETTLEMENT:${-planned}`, `BANK_REFUND:REVIEW_TASK:${-EDIT_CENTS}`, `CANCELLATION_FEE:CANCELLATION:${GROUP_CHILD_CENTS - planned - EDIT_CENTS}`].sort(),
      );
      // The organiser's own hand-back carries only the plan's refunds, never the edit's paid one again.
      const organiserTask = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: g.organiser, occurrenceKey: `group-organiser-hand-back:${g.settlement}` }, select: { amountCents: true } });
      expect(organiserTask.amountCents).toBe(planned + GROUP_CHILD_CENTS / 2);
      expect(await settlementStatus(g)).toBe("SUCCEEDED");

      // Re-driven again, and the settlement's replay asked: nothing moves.
      await cancelGroupHistory(NAMES, g);
      const { executeGroupSettlementRefundPlan } = await import("@/lib/group-cancel");
      expect(await executeGroupSettlementRefundPlan(g.settlement, CLUB_FORMAT_TEST)).toEqual({ outcome: "not_refundable", mirroredChildren: 0 });
      expect((await payment(edited!)).refundedAmountCents).toBe(EDIT_CENTS + planned);
      const report = await census();
      expect(about(report, edited!), `interrupted=${interrupted}`).toEqual(PAID_BACK);
      expect(about(report, other!), `interrupted=${interrupted}`).toEqual(NOTHING);
    }
  }, 300_000);
});
