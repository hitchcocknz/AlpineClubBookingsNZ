import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManualRefundTaskKind, ManualRefundTaskStatus } from "@prisma/client";

/**
 * #4042 (`INV-PAY-123`): the hand-back an organiser's Internet Banking group
 * cancel keeps for the organiser. Its total is DERIVED on every claim - the
 * joiners the ledger proves refunded, those a group task records, and this
 * claim's - less what closed group tasks repaid; a share booked after the task
 * closed raises a supplementary task for what nothing covers. Where the cancel
 * calls these is `group-cancel.test.ts`; the row against the real schema and a
 * completion that moves nothing are `booking-ledger-group-settlement.realdb.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  taskFindMany: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  bookingFindMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  organiserFindUniqueOrThrow: vi.fn(),
  taskFindUniqueOrThrow: vi.fn(),
  prismaTaskFindMany: vi.fn(),
  prismaTaskUpdateMany: vi.fn(),
  sendAdminManualRefundTaskAlert: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUniqueOrThrow: mocks.organiserFindUniqueOrThrow },
    manualRefundTask: { findUniqueOrThrow: mocks.taskFindUniqueOrThrow, findMany: mocks.prismaTaskFindMany, updateMany: mocks.prismaTaskUpdateMany },
  },
}));
vi.mock("@/lib/email", () => ({ sendAdminManualRefundTaskAlert: mocks.sendAdminManualRefundTaskAlert }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn() } }));

import {
  alertUnsentGroupOrganiserHandBacks,
  composeGroupHandBackReason,
  recordGroupOrganiserHandBackShare,
} from "@/lib/group-organiser-hand-back";
import {
  isNonCancellationHandBackTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  groupOrganiserHandBackOccurrenceKey,
  isGroupOrganiserHandBackTask,
  readGroupOrganiserHandBackShares,
} from "@/lib/group-organiser-hand-back-rules";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const tx = {
  manualRefundTask: { findMany: mocks.taskFindMany, updateMany: mocks.updateMany, create: mocks.create },
  booking: { findMany: mocks.bookingFindMany },
  bookingLedgerLine: { findMany: mocks.ledgerFindMany },
} as unknown as Parameters<typeof recordGroupOrganiserHandBackShare>[0];

const INPUT = {
  settlementId: "settle-1",
  organiserBookingId: "org-booking",
  plan: new Map([["child-a", 4500], ["child-b", 3000], ["child-c", 0]]),
  claimedChildId: "child-a",
  format: CLUB_FORMAT_TEST,
};
const KEY = "group-organiser-hand-back:settle-1";
const NAMES: Record<string, [string, string]> = { "child-a": ["Ana", "Joiner"], "child-b": ["Ben", "Joiner, Jr"], "child-d": ["Dee", "Joiner"] };

const refundLine = (bookingId: string, cents: number) => ({ bookingId, amountCents: -cents });
const share = (bookingId: string, cents: number) => ({ bookingId, name: NAMES[bookingId]!.join(" "), cents });
const openTask = (amountCents: number, shares: ReturnType<typeof share>[], status: ManualRefundTaskStatus = ManualRefundTaskStatus.OPEN, occurrenceKey = KEY) => ({
  id: occurrenceKey === KEY ? "task-1" : "task-s",
  occurrenceKey,
  status,
  amountCents,
  reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taskFindMany.mockResolvedValue([]);
  mocks.ledgerFindMany.mockResolvedValue([]);
  mocks.bookingFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.map((id) => ({ id, member: { firstName: NAMES[id]![0], lastName: NAMES[id]![1] }, organisation: null })),
  );
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.create.mockResolvedValue({ id: "task-new" });
  mocks.sendAdminManualRefundTaskAlert.mockResolvedValue(undefined);
});

function created() {
  return (mocks.create.mock.calls[0] as [{ data: Record<string, unknown> & { reviewContext: unknown; reason: string } }])[0].data;
}
function updated() {
  return (mocks.updateMany.mock.calls[0] as [{ where: unknown; data: Record<string, unknown> & { reviewContext: unknown; reason: string } }])[0];
}

describe("recordGroupOrganiserHandBackShare", () => {
  it("the first share creates ONE cancellation hand-back on the organiser's booking, with no payment and its share recorded as data", async () => {
    const raised = await recordGroupOrganiserHandBackShare(tx, INPUT);

    expect(mocks.taskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ occurrenceKey: KEY }, { occurrenceKey: { startsWith: `${KEY}:` } }] },
    }));
    expect(mocks.ledgerFindMany).toHaveBeenCalledWith({
      where: { postingKey: { in: ["group-settlement:settle-1:refund:child-a", "group-settlement:settle-1:refund:child-b"] } },
      select: { bookingId: true, amountCents: true },
    });
    const data = created();
    expect(data).toMatchObject({
      bookingId: "org-booking",
      amountCents: 4500,
      raisedAmountCents: 4500,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: KEY,
      reason: "Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $45.00 by bank transfer. Joiners' shares: Ana Joiner $45.00.",
    });
    expect(data).not.toHaveProperty("paymentId");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)).toEqual({ settlementId: "settle-1", shares: [share("child-a", 4500)] });
    expect(raised).toEqual({ id: "task-new", amountCents: 4500, created: true });
  });

  it("a later share SETS the open task to the derived total by a status-guarded update, never an increment", async () => {
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)])]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500)]);

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    const { where, data } = updated();
    expect(where).toEqual({ id: "task-1", status: ManualRefundTaskStatus.OPEN });
    expect(data).toMatchObject({ amountCents: 7500, raisedAmountCents: 7500 });
    expect(data.reason).toContain("Repay the organiser $75.00 by bank transfer. Joiners' shares: Ana Joiner $45.00, Ben Joiner, Jr $30.00.");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares).toEqual([share("child-a", 4500), share("child-b", 3000)]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(raised).toEqual({ id: "task-1", amountCents: 7500, created: false });
  });

  it("OVERLAP: a joiner whose refund line is on the ledger but who never grew the task (an older release claimed it) is counted", async () => {
    // child-b was claimed by the previous release: its line exists, the task does not record it.
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)])]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500), refundLine("child-b", 3000)]);

    await recordGroupOrganiserHandBackShare(tx, { ...INPUT, plan: new Map([...INPUT.plan, ["child-d", 1000]]), claimedChildId: "child-d" });

    const { data } = updated();
    expect(data).toMatchObject({ amountCents: 8500, raisedAmountCents: 8500 });
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares.map((s) => s.bookingId)).toEqual(["child-a", "child-b", "child-d"]);
  });

  it("a soft-deleted joiner whose refund line is on the ledger is counted: the line is the proof, no deletedAt filter", async () => {
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-b", 3000)]);

    await recordGroupOrganiserHandBackShare(tx, INPUT);

    expect(created()).toMatchObject({ amountCents: 7500 });
    const [[{ where }]] = mocks.bookingFindMany.mock.calls as [[{ where: Record<string, unknown> }]];
    expect(where).toEqual({ id: { in: ["child-b", "child-a"] } });
  });

  it("a share booked after the task was completed raises a supplementary task for only what no task covers", async () => {
    mocks.taskFindMany.mockResolvedValue([openTask(4500, [share("child-a", 4500)], ManualRefundTaskStatus.COMPLETED)]);
    mocks.ledgerFindMany.mockResolvedValue([refundLine("child-a", 4500)]);

    const raised = await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    expect(mocks.updateMany).not.toHaveBeenCalled();
    const data = created();
    expect(data).toMatchObject({ occurrenceKey: `${KEY}:child-b`, amountCents: 3000, raisedAmountCents: 3000 });
    expect(data.reason).toContain("recorded after the group's repayment task was closed: repay the organiser $30.00");
    expect(readGroupOrganiserHandBackShares(data.reviewContext)?.shares).toEqual([share("child-b", 3000)]);
    expect(raised).toEqual({ id: "task-new", amountCents: 3000, created: true });
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `${KEY}:child-b` })).toBe(true);
  });

  it("nothing more is raised when every share is already covered, or for a joiner the plan owes nothing", async () => {
    mocks.taskFindMany.mockResolvedValue([
      openTask(4500, [share("child-a", 4500)], ManualRefundTaskStatus.COMPLETED),
      openTask(3000, [share("child-b", 3000)], ManualRefundTaskStatus.OPEN, `${KEY}:child-b`),
    ]);
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" })).toBeNull();
    expect(await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-c" })).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("the hand-back's reason", () => {
  it("lists shares up to the column, then counts the rest from the data, whatever the names contain", () => {
    const shares = Array.from({ length: 20 }, (_, index) => ({ name: `Joiner, Number ${index + 1}`, cents: 1000 + index }));
    const reason = composeGroupHandBackReason({ totalCents: 123_456, shares, supplementary: false, format: CLUB_FORMAT_TEST });
    expect(reason.length).toBeLessThanOrEqual(500);
    expect(reason).toContain("Repay the organiser $1,234.56 by bank transfer.");
    const more = / … and (\d+) more \(see each joiner's booking\)\.$/.exec(reason);
    expect(more).not.toBeNull();
    const listed = shares.filter((s) => reason.includes(`${s.name} $`)).length;
    expect(listed + Number(more![1])).toBe(20);
  });

  it("lists every share when they fit", () => {
    expect(composeGroupHandBackReason({ totalCents: 7500, shares: [{ name: "Ana Joiner", cents: 4500 }, { name: "Ben Joiner", cents: 3000 }], supplementary: false, format: CLUB_FORMAT_TEST }))
      .toBe("Group cancelled by its organiser - paid by Internet Banking. Repay the organiser $75.00 by bank transfer. Joiners' shares: Ana Joiner $45.00, Ben Joiner $30.00.");
  });
});

describe("the hand-back's marker", () => {
  it("is its own prefix: a cancellation's hand-back, never an edit's or an appeal's", () => {
    const task = { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: groupOrganiserHandBackOccurrenceKey("s") };
    expect(isGroupOrganiserHandBackTask(task)).toBe(true);
    expect(isNonCancellationHandBackTask(task)).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: null })).toBe(false);
    expect(isGroupOrganiserHandBackTask({ kind: "EDIT_FINANCIAL_REVIEW", occurrenceKey: task.occurrenceKey })).toBe(false);
    // The query fragment the cancellation readers spread keeps it (a NOT on the two other prefixes).
    expect(JSON.stringify(NOT_NON_CANCELLATION_HAND_BACK_WHERE)).not.toContain("group-organiser-hand-back:");
  });
});

describe("alertUnsentGroupOrganiserHandBacks", () => {
  const CONTEXT = { groupOrganiserHandBack: { settlementId: "settle-1", shares: [share("child-a", 4500), share("child-b", 3000)] } };
  const SENT = { groupOrganiserHandBack: { ...CONTEXT.groupOrganiserHandBack, alertSentAt: "2026-07-01T00:00:00.000Z" } };
  const INPUT_SWEEP = { settlementId: "settle-1", organiserBookingId: "org-booking", format: CLUB_FORMAT_TEST };

  beforeEach(() => {
    mocks.organiserFindUniqueOrThrow.mockResolvedValue({
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-03T00:00:00.000Z"),
      member: { firstName: "Olive", lastName: "Organiser" },
      organisation: null,
    });
    mocks.sendAdminManualRefundTaskAlert.mockResolvedValue("sent");
    mocks.taskFindUniqueOrThrow.mockResolvedValue({ reviewContext: CONTEXT });
    mocks.prismaTaskUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("sends an OPEN task's unsent alert in its group wording, with the amount and reason read now, then records it as sent fenced on what it read", async () => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "task-1", amountCents: 7500, reason: "final reason", reviewContext: CONTEXT }]);

    await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);

    expect(mocks.prismaTaskFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ occurrenceKey: KEY }, { occurrenceKey: { startsWith: `${KEY}:` } }], status: ManualRefundTaskStatus.OPEN },
    }));
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledWith(
      {
        memberName: "Olive Organiser",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        refundAmountCents: 7500,
        bookingId: "org-booking",
        reason: "final reason",
        situation: "group-organiser-internet-banking",
      },
      CLUB_FORMAT_TEST,
    );
    const [[{ where, data }]] = mocks.prismaTaskUpdateMany.mock.calls as [[{ where: unknown; data: { reviewContext: unknown } }]];
    expect(where).toEqual({ id: "task-1", reviewContext: { equals: CONTEXT } });
    const recorded = readGroupOrganiserHandBackShares(data.reviewContext);
    expect(recorded?.shares).toEqual(CONTEXT.groupOrganiserHandBack.shares);
    expect(recorded?.alertSentAt).toEqual(expect.any(String));
  });

  it("RESUME: a task whose creating run died before its alert is sent by the next run - and once recorded, never again", async () => {
    // The crashed run committed the task; nothing recorded an alert.
    mocks.prismaTaskFindMany.mockResolvedValueOnce([{ id: "task-1", amountCents: 7500, reason: "r", reviewContext: CONTEXT }]);
    await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(1);

    // The run after that reads the recorded send and sends nothing.
    mocks.prismaTaskFindMany.mockResolvedValueOnce([{ id: "task-1", amountCents: 7500, reason: "r", reviewContext: SENT }]);
    await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);
    expect(mocks.sendAdminManualRefundTaskAlert).toHaveBeenCalledTimes(1);
  });

  it("does not record a send that reached nobody, so a later run retries it", async () => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "task-1", amountCents: 7500, reason: "r", reviewContext: CONTEXT }]);
    mocks.sendAdminManualRefundTaskAlert.mockResolvedValue("undelivered");

    await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);

    expect(mocks.prismaTaskUpdateMany).not.toHaveBeenCalled();
  });

  it("re-reads and records again when a claim grew the task between the send and the record", async () => {
    mocks.prismaTaskFindMany.mockResolvedValue([{ id: "task-1", amountCents: 7500, reason: "r", reviewContext: CONTEXT }]);
    const grown = { groupOrganiserHandBack: { settlementId: "settle-1", shares: [...CONTEXT.groupOrganiserHandBack.shares, share("child-d", 1000)] } };
    mocks.taskFindUniqueOrThrow.mockResolvedValueOnce({ reviewContext: CONTEXT }).mockResolvedValueOnce({ reviewContext: grown });
    mocks.prismaTaskUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP);

    expect(mocks.prismaTaskUpdateMany).toHaveBeenCalledTimes(2);
    const second = (mocks.prismaTaskUpdateMany.mock.calls[1] as [{ where: unknown; data: { reviewContext: unknown } }])[0];
    expect(second.where).toEqual({ id: "task-1", reviewContext: { equals: grown } });
    expect(readGroupOrganiserHandBackShares(second.data.reviewContext)?.shares).toHaveLength(3);
  });

  it("never throws: the cancellation has committed, and the task is the record", async () => {
    mocks.prismaTaskFindMany.mockRejectedValue(new Error("db down"));

    await expect(alertUnsentGroupOrganiserHandBacks(INPUT_SWEEP)).resolves.toBeUndefined();
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });
});

describe("a growing claim keeps the alert's record", () => {
  it("rewrites the shares and keeps alertSentAt, so a sent alert is never sent again", async () => {
    mocks.taskFindMany.mockResolvedValue([
      { ...openTask(4500, [share("child-a", 4500)]), reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares: [share("child-a", 4500)], alertSentAt: "2026-07-01T00:00:00.000Z" } } },
    ]);

    await recordGroupOrganiserHandBackShare(tx, { ...INPUT, claimedChildId: "child-b" });

    expect(readGroupOrganiserHandBackShares(updated().data.reviewContext)?.alertSentAt).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("the finance queue payload marks it for the card's own sentence", () => {
  it("true for the group key only", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "task-1",
      bookingId: "org-booking",
      amountCents: 7500,
      raisedAmountCents: 7500,
      kind: "CANCELLED_BOOKING_HAND_BACK",
      paymentId: null,
      payment: null,
      lateCaptureApprovalIntentId: null,
      partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null,
      partPaymentReviewXeroPaidCents: null,
      occurrenceKey: groupOrganiserHandBackOccurrenceKey("settle-1"),
      reviewContext: null,
      reason: "r",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        member: { firstName: "Olive", lastName: "Organiser" },
        organisation: null,
        memberId: "olive",
        deletedAt: null,
        status: "CANCELLED",
        payment: null,
      },
    };
    const payload = toOpenManualRefundTaskPayload(row, null, []);
    expect(payload).toMatchObject({ groupOrganiserHandBack: true, editRefundHandBack: false, refundRequestHandBack: false, memberName: "Olive Organiser" });
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: null }, null, []).groupOrganiserHandBack).toBe(false);
    // Its shares are kept in reviewContext: never read as unreadable review evidence.
    const withShares = toOpenManualRefundTaskPayload({ ...row, reviewContext: { groupOrganiserHandBack: { settlementId: "settle-1", shares: [] } } }, null, []);
    expect(withShares).toMatchObject({ reviewEvidence: null, reviewEvidenceUnreadable: false });
  });
});
