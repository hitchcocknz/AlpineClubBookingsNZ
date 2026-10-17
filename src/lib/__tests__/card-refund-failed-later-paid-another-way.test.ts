// #4210 (`INV-PAY-136`): a card refund a "Paid another way" close had already
// settled is not owed again when Stripe fails it later - and nothing else is
// hidden. These are the rules of `findPaidAnotherWayCloseThatSettled` as the
// failed-later writer (`keepFailedLaterCardRefundOwed`) applies them, against a
// fake transaction. The real-database proof is
// `cancel-card-refund-failed-later.realdb.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const alertPaymentRecoveryOfficers = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined));
const sendAdminCardRefundFailedAfterPaidAnotherWayAlert = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined));
vi.mock("@/lib/payment-recovery-alert", () => ({ alertPaymentRecoveryOfficers }));
vi.mock("@/lib/email/admin-alerts-card-refund", () => ({ alertCardRefundFailedAfterPaidAnotherWay: sendAdminCardRefundFailedAfterPaidAnotherWayAlert }));
vi.mock("@/lib/club-format-server", async () => ({
  clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST,
}));

import { lastErrorSuggestsStripeMayHaveRefunded } from "@/lib/card-refund-paid-another-way";
import {
  alertFailedLaterCardRefunds,
  keepFailedLaterCardRefundOwed,
  type FailedLaterCardRefundDebt,
  type FailedLaterKind,
  type FailedLaterRefundInput,
} from "@/lib/card-refund-failed-later";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { bookingModificationRefundReasonForKeyPrefix } from "@/lib/payment-recovery-keys";

const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");
/** When Stripe made X - its answer lost - and when the officer closed the row "Paid another way". */
const MADE_AT = new Date("2026-06-20T00:00:05.000Z");
const CLOSED_AT = new Date("2026-06-20T00:00:10.000Z");
/** After the close: the `charge.refunded` sync that finally recorded X. */
const RECORDED_LATE = new Date("2026-06-20T00:00:20.000Z");

type Row = Record<string, unknown> & { id: string };

function row(over: Partial<Row> = {}): Row {
  return {
    id: "op-cancel",
    type: "REFUND_BOOKING_MODIFICATION",
    status: "SUCCEEDED",
    attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
    nextRetryAt: null,
    idempotencyKey: "booking_cancel_refund_recovery_booking-1",
    stripeKeyPrefix: null,
    amountCents: 4_000,
    allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000 }],
    paymentTransactionId: null,
    bookingId: "booking-1",
    paymentIntentId: "pi_1",
    createdAt: RAISED_AT,
    succeededAt: CLOSED_AT,
    ...over,
  };
}

/** The close's record: paid back in full unless told otherwise. */
const closeRecord = (over: Record<string, unknown> = {}) => ({ id: "task-close", amountCents: 4_000, raisedAmountCents: 4_000, reviewContext: null, ...over });

function fakeTx({
  rows = [row()] as Row[],
  close = closeRecord() as Record<string, unknown> | null,
  recordedAt = RECORDED_LATE,
  madeAt = MADE_AT,
} = {}) {
  return {
    payment: {
      findUnique: vi.fn(async () => ({ id: "pay-1", bookingId: "booking-1", status: "PARTIALLY_REFUNDED", amountCents: 20_000, refundedAmountCents: 4_000 })),
    },
    paymentRefund: {
      findMany: vi.fn(async () => [{ stripeRefundId: "re_1", paymentTransactionId: "txn-1", amountCents: 4_000, status: "failed", createdAt: recordedAt, stripeCreatedAt: madeAt }]),
    },
    paymentTransaction: { findUnique: vi.fn(async () => ({ stripePaymentIntentId: "pi_txn" })) },
    auditLog: { create: vi.fn<(args: unknown) => Promise<object>>(async () => ({})) },
    manualRefundTask: { findFirst: vi.fn<(args: unknown) => Promise<Record<string, unknown> | null>>(async () => close) },
    paymentRecoveryOperation: {
      findMany: vi.fn(async () => rows),
      createMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
      updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
      findUniqueOrThrow: vi.fn(async () => ({ id: "op-new" })),
    },
  };
}

/** X: the cancellation row's own refund, carrying exactly what its runner sends. */
const X: FailedLaterRefundInput = { id: "re_1", amount: 4_000, status: "failed", created: Math.floor(MADE_AT.getTime() / 1000), metadata: { bookingId: "booking-1", reason: "cancellation" } };
const APPEAL = { bookingId: "booking-1", reason: "refund_appeal_approved", refundRequestId: "rr-1" };

const keep = (tx: ReturnType<typeof fakeTx>, refund: FailedLaterRefundInput = X, kind: FailedLaterKind = "transition") =>
  keepFailedLaterCardRefundOwed(tx as never, { paymentId: "pay-1", paymentTransactionId: "txn-1", refund, kind, paymentIntentId: "pi_1", cutoffSeconds: null });
const inserted = (tx: ReturnType<typeof fakeTx>) =>
  (tx.paymentRecoveryOperation.createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>> } | undefined)?.data[0];
const audited = (tx: ReturnType<typeof fakeTx>) => tx.auditLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;

beforeEach(() => {
  alertPaymentRecoveryOfficers.mockClear();
  sendAdminCardRefundFailedAfterPaidAnotherWayAlert.mockClear();
});

describe("settled: the row that sent it was closed \"Paid another way\" and the close never counted it", () => {
  it("MUTATION: recorded after the close (the paid-twice reading): no row, audited, the decision on the debt", async () => {
    const tx = fakeTx();
    expect(await keep(tx)).toEqual({
      debt: {
        outcome: "settled-paid-another-way",
        operationId: "op-cancel",
        bookingId: "booking-1",
        paymentIntentId: "pi_1",
        amountCents: 4_000,
        stripeRefundId: "re_1",
        paidAnotherWay: { recordId: "task-close", operationId: "op-cancel", paidBackCents: 4_000, owedCents: 4_000, checkCents: 0, onPaidTwiceList: true, resolutionNote: null },
      },
    });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
    // The close's own record, by the one way to find it, COMPLETED.
    const where = (tx.manualRefundTask.findFirst.mock.calls[0]?.[0] as { where: { occurrenceKey: { in: string[] }; status: string } }).where;
    expect(where.occurrenceKey.in).toContain(cardRefundPaidAnotherWayOccurrenceKey("op-cancel", { xeroRefundNote: "now" }));
    expect(where.status).toBe("COMPLETED");
    expect(audited(tx)).toMatchObject({
      data: { action: "booking-payment.card-refund.failed-later-paid-another-way", entityType: "PaymentRefund", entityId: "re_1", targetId: "booking-1", category: "payment" },
    });
  });

  it("seen again by a replay, it writes and alerts nothing", async () => {
    const tx = fakeTx();
    expect(await keep(tx, X, "replayed")).toEqual({});
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION (concurrency F2): recorded BEFORE the close but filling a newer row's slice - the close paid it by bank: settled", async () => {
    const newer = row({ id: "op-edit", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", createdAt: new Date("2026-06-20T00:00:01.000Z"), succeededAt: null });
    const tx = fakeTx({ rows: [row(), newer], recordedAt: MADE_AT });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-cancel", paidAnotherWay: { onPaidTwiceList: false } } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    expect(tx.paymentRecoveryOperation.updateMany).not.toHaveBeenCalled();
  });

  it("MUTATION: a failed-later row's retry, that row closed \"Paid another way\" first: settled, never raised dead for a second close", async () => {
    const retryRow = row({ id: "op-fl", idempotencyKey: "card_refund_failed_later_re_0", stripeKeyPrefix: "card_refund_failed_later_re_0" });
    const tx = fakeTx({ rows: [retryRow] });
    const retry = { ...X, metadata: { bookingId: "booking-1", reason: bookingModificationRefundReasonForKeyPrefix("card_refund_failed_later_re_0") } };
    expect(await keep(tx, retry)).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-fl" } });
    expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
  });

  it("MUTATION (UX2): a dashboard refund (no metadata) the closed row's paid-twice figure counted: settled, never \"not re-sent\"", async () => {
    const tx = fakeTx();
    expect(await keep(tx, { ...X, metadata: null })).toMatchObject({ debt: { outcome: "settled-paid-another-way", operationId: "op-cancel" } });
    expect(audited(tx)?.data.action).toBe("booking-payment.card-refund.failed-later-paid-another-way");
  });
});

describe("owed again as before: never settled by a close that did not settle it", () => {
  it("MUTATION (control): recorded before the close and filling that row's slice - the close counted it as made: re-sent", async () => {
    const tx = fakeTx({ recordedAt: MADE_AT });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0, amountCents: 4_000 });
  });

  it("MUTATION (boundary): recorded in the very instant of the close is not after it: re-sent", async () => {
    const tx = fakeTx({ recordedAt: CLOSED_AT });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
  });

  it("MUTATION (boundary): made by Stripe in the instant of the close is the close's; a second later is not (money F1)", async () => {
    expect(await keep(fakeTx({ madeAt: CLOSED_AT }))).toMatchObject({ debt: { outcome: "settled-paid-another-way" } });
    // A later refund carrying the closed row's metadata - a second change's, say - made after the close.
    const later = fakeTx({ madeAt: new Date(CLOSED_AT.getTime() + 1_000) });
    expect(await keep(later)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(later)).toMatchObject({ attempts: 0 });
  });

  it("MUTATION (control): a row closed by its own refund, with no \"Paid another way\" record: re-sent", async () => {
    const tx = fakeTx({ close: null });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0 });
  });

  it("MUTATION (money F2): another door's refund for this booking (an approved request's) that fills the closed row's slice by amount: re-sent", async () => {
    const tx = fakeTx();
    expect(await keep(tx, { ...X, metadata: APPEAL })).toMatchObject({ debt: { outcome: "raised" } });
    expect(inserted(tx)).toMatchObject({ attempts: 0, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: null }] });
    expect(tx.manualRefundTask.findFirst).not.toHaveBeenCalled();
  });

  describe("concurrency F1: sent by an open row R, filling the closed row's slice by amount", () => {
    // R's slice does not fit X, so X fills the closed cancel row's - but R sent it.
    const r = row({ id: "op-r", status: "FAILED", attempts: 1, nextRetryAt: CLOSED_AT, idempotencyKey: "payment_recovery_modification_refund_mod-1", allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 3_999 }], succeededAt: null });
    const RS = { ...X, metadata: { bookingId: "booking-1", reason: "booking_modification_refund_recovery" } };

    it("MUTATION: decided on R alone - a row of its own owes it, made by R", async () => {
      const tx = fakeTx({ rows: [row(), r] });
      expect(await keep(tx, RS)).toMatchObject({ debt: { outcome: "raised" } });
      expect(inserted(tx)).toMatchObject({ attempts: 0, allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 4_000, madeByOperationId: "op-r" }] });
    });

    it("MUTATION: R's own replay reads it as refused, and R moves its slice itself", async () => {
      const tx = fakeTx({ rows: [row(), r] });
      expect(await keep(tx, RS, "replayed")).toEqual({ readAsRefused: true });
      expect(tx.paymentRecoveryOperation.createMany).not.toHaveBeenCalled();
    });
  });
});

describe("what a close may not have covered is raised dead, for an officer to check", () => {
  it("MUTATION (F3): a part close - the part it gave up, at most this refund, never sent", async () => {
    const tx = fakeTx({ close: closeRecord({ amountCents: 2_500, raisedAmountCents: 4_000 }) });
    expect(await keep(tx)).toMatchObject({
      debt: { outcome: "raised-check-part-close", operationId: "op-new", amountCents: 4_000, paidAnotherWay: { paidBackCents: 2_500, owedCents: 4_000, checkCents: 1_500 } },
    });
    expect(inserted(tx)).toMatchObject({
      idempotencyKey: "card_refund_failed_later_re_1",
      amountCents: 1_500,
      attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS,
      allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 1_500, madeByOperationId: "op-cancel" }],
    });
    // Stripe sent nothing: no "Stripe may have refunded" warning on the row.
    expect(lastErrorSuggestsStripeMayHaveRefunded(String(inserted(tx)?.lastError))).toBe(false);
    expect(audited(tx)?.data).toMatchObject({ action: "booking-payment.card-refund.failed-later-paid-another-way" });
  });

  it("MUTATION (F4): its paid-twice row marked Resolved - the member may have returned the extra: the whole refund, never sent", async () => {
    const reviewContext = { paidTwiceResolved: { resolvedAt: "2026-06-21T00:00:00.000Z", resolvedByMemberId: "officer", note: "Member returned it by bank", refundedByCardCents: 4_000 } };
    const tx = fakeTx({ close: closeRecord({ reviewContext }) });
    expect(await keep(tx)).toMatchObject({ debt: { outcome: "raised-check-resolved", paidAnotherWay: { checkCents: 4_000, resolutionNote: "Member returned it by bank" } } });
    expect(inserted(tx)).toMatchObject({ amountCents: 4_000, attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS });
    expect(audited(tx)?.data).toMatchObject({ details: "Member returned it by bank" });
  });
});

describe("the officers' alert: its own unmuteable mail", () => {
  const debt = (over: Partial<FailedLaterCardRefundDebt> = {}): FailedLaterCardRefundDebt => ({
    outcome: "settled-paid-another-way",
    operationId: "op-cancel",
    bookingId: "booking-1",
    paymentIntentId: "pi_1",
    amountCents: 4_000,
    stripeRefundId: "re_1",
    paidAnotherWay: { recordId: "task-close", operationId: "op-cancel", paidBackCents: 4_000, owedCents: 4_000, checkCents: 0, onPaidTwiceList: true, resolutionNote: null },
    ...over,
  });
  const noteOf = (call = 0) => (sendAdminCardRefundFailedAfterPaidAnotherWayAlert.mock.calls[call] as unknown as [{ note: string }])[0].note;

  it("MUTATION (UX1, UX6): settled - sent through its own sender, never the payment-failure alert, and says not to pay again", async () => {
    await alertFailedLaterCardRefunds([debt()]);
    expect(alertPaymentRecoveryOfficers).not.toHaveBeenCalled();
    expect(sendAdminCardRefundFailedAfterPaidAnotherWayAlert).toHaveBeenCalledTimes(1);
    expect(noteOf()).toMatch(/card refund re_1 of \$40\.00 failed .*closed as paid another way.*paid the member back \$40\.00\. It showed under "Card refunds paid back twice", and leaves that list now\./);
    expect(noteOf()).toMatch(/Do not pay the member again unless they have already returned the extra; if you only asked, tell them not to send it\./);
  });

  it("MUTATION (UX4): claims nothing about the paid-twice list when the refund was never on it", async () => {
    await alertFailedLaterCardRefunds([debt({ paidAnotherWay: { ...debt().paidAnotherWay!, onPaidTwiceList: false } })]);
    expect(noteOf()).not.toMatch(/paid back twice/);
  });

  it("says what a part close or a resolved row leaves to check, and how much", async () => {
    await alertFailedLaterCardRefunds([
      debt({ outcome: "raised-check-part-close", paidAnotherWay: { ...debt().paidAnotherWay!, paidBackCents: 2_500, checkCents: 1_500 } }),
      debt({ outcome: "raised-check-resolved", paidAnotherWay: { ...debt().paidAnotherWay!, checkCents: 4_000, resolutionNote: "Returned by bank" } }),
    ]);
    expect(noteOf(0)).toMatch(/paid the member back \$25\.00 of the \$40\.00 it owed and gave the rest up.*Up to \$15\.00 of this refund may be part of what the close gave up/);
    expect(noteOf(1)).toMatch(/marked resolved under "Card refunds paid back twice", with the note: "Returned by bank"\. If the member returned the extra, they are owed \$40\.00 again/);
  });
});
