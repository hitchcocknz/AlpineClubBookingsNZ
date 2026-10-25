import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  transactionFindUnique: vi.fn(),
  taskFindUnique: vi.fn(),
  paymentFindUnique: vi.fn(),
  linkFindMany: vi.fn(),
  linkFindFirst: vi.fn(),
  operationFindFirst: vi.fn(),
  operationFindMany: vi.fn(),
  modificationFindUnique: vi.fn(),
  executeRaw: vi.fn(),
  lockKeptLateCaptureTask: vi.fn(),
  lockSupplementaryInvoiceAnchor: vi.fn(),
  findLiveKeptReceiptRow: vi.fn(),
  enqueueAdditionalCaptureReceiptOperation: vi.fn(),
}));

vi.mock("@/lib/xero-kept-late-capture-invoice", () => ({
  enqueueXeroKeptLateCaptureInvoiceOperation: (...a: unknown[]) =>
    mocks.enqueueXeroKeptLateCaptureInvoiceOperation(...a),
  keptLateCaptureDocumentDate: () => "2026-06-10",
  lockKeptLateCaptureTask: (...a: unknown[]) => mocks.lockKeptLateCaptureTask(...a),
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  kickQueuedXeroOutboxOperationsIfConnected: (...a: unknown[]) =>
    mocks.kickQueuedXeroOutboxOperationsIfConnected(...a),
  lockSupplementaryInvoiceAnchor: (...a: unknown[]) => mocks.lockSupplementaryInvoiceAnchor(...a),
}));
// The REAL retired codes: a copy here would let the constant drift unseen.
vi.mock("@/lib/xero-supplementary-invoice-late-capture", async (importOriginal) => ({
  RETIRED_CODES_ANSWERING_CAPTURE: (
    (await importOriginal()) as typeof import("@/lib/xero-supplementary-invoice-late-capture")
  ).RETIRED_CODES_ANSWERING_CAPTURE,
  releaseXeroSupplementaryInvoiceForCapturedPaymentIntent: (...a: unknown[]) =>
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(...a),
}));
vi.mock("@/lib/kept-late-capture-receipt-rows", () => ({
  findLiveKeptReceiptRow: (...a: unknown[]) => mocks.findLiveKeptReceiptRow(...a),
}));
vi.mock("@/lib/additional-capture-receipt-enqueue", () => ({
  enqueueAdditionalCaptureReceiptOperation: (...a: unknown[]) => mocks.enqueueAdditionalCaptureReceiptOperation(...a),
}));
vi.mock("@/lib/additional-capture-xero-receipt", () => ({
  additionalCaptureReceiptKey: (intent: string) => `receipt-key:${intent}`,
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  creditBackLateCaptureRefunds: (...a: unknown[]) => mocks.creditBackLateCaptureRefunds(...a),
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  finishKeptLateCaptureXeroRecord,
  planKeptLateCaptureXeroRecord,
  readKeptChangeCaptureEvidence,
} from "@/lib/late-capture-kept-xero";
import {
  decideLateCapture,
  keptChangeCaptureRoute,
  keptLateCaptureInvoiceAsked,
  keptLateCaptureRecordRoute,
  type KeptChangeCaptureEvidence,
} from "@/lib/late-capture-kept-xero-rules";
import type { ClubTimeZone } from "@/lib/club-time";

/**
 * #3635 (owner decision 29 Sep 2026): a late capture a treasurer KEPT on a
 * cancelled booking is recorded in Xero by the app. The one decision, and the
 * dismissal's two halves; the document itself is
 * `xero-kept-late-capture-invoice.test.ts`'s and the resulting books
 * `xero-kept-late-capture-ledger.test.ts`'s.
 */
const store = {
  paymentTransaction: { findUnique: (...a: unknown[]) => mocks.transactionFindUnique(...a) },
  manualRefundTask: { findUnique: (...a: unknown[]) => mocks.taskFindUnique(...a) },
  payment: { findUnique: (...a: unknown[]) => mocks.paymentFindUnique(...a) },
  // The payment's active PRIMARY_INVOICE links (`bookingHasPrimaryXeroInvoice`).
  xeroObjectLink: {
    findMany: (...a: unknown[]) => mocks.linkFindMany(...a),
    findFirst: (...a: unknown[]) => mocks.linkFindFirst(...a),
  },
  xeroSyncOperation: {
    findFirst: (...a: unknown[]) => mocks.operationFindFirst(...a),
    findMany: (...a: unknown[]) => mocks.operationFindMany(...a),
  },
  bookingModification: { findUnique: (...a: unknown[]) => mocks.modificationFindUnique(...a) },
  $executeRaw: (...a: unknown[]) => mocks.executeRaw(...a),
};

function plan() {
  return planKeptLateCaptureXeroRecord({
    manualRefundTaskId: "task_kept",
    bookingId: "booking-1",
    paymentIntentId: "pi_late",
    actingMemberId: "treasurer-1",
    clubZone: "Pacific/Auckland" as ClubTimeZone,
    store: store as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionFindUnique.mockResolvedValue({
    kind: "PRIMARY",
    status: "SUCCEEDED",
    amountCents: 24000,
    paymentId: "payment-1",
  });
  mocks.taskFindUnique.mockResolvedValue({ createdAt: new Date("2026-06-10T01:00:00Z"), status: "DISMISSED" });
  mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: null });
  mocks.linkFindMany.mockResolvedValue([]);
  mocks.linkFindFirst.mockResolvedValue(null);
  mocks.operationFindFirst.mockResolvedValue(null);
  mocks.operationFindMany.mockReset().mockResolvedValue([]);
  mocks.modificationFindUnique.mockResolvedValue({ newData: {} });
  mocks.findLiveKeptReceiptRow.mockResolvedValue(null);
  mocks.enqueueAdditionalCaptureReceiptOperation.mockResolvedValue({ outcome: "queued", queueOperationId: "op_receipt" });
  mocks.enqueueXeroKeptLateCaptureInvoiceOperation.mockResolvedValue({
    queueOperationId: "op_kept",
    message: "queued",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.creditBackLateCaptureRefunds.mockResolvedValue(undefined);
  mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockResolvedValue({
    released: 1,
    queueOperationIds: ["op_supp"],
    outcome: "released",
  });
});

describe("decideLateCapture (the one decision)", () => {
  const capture = { status: "SUCCEEDED" as const, amountCents: 24000 };
  it("lets a task decide; with none, the webhook's routing", () => {
    expect(decideLateCapture({ taskStatus: "OPEN", bookingStatus: "CANCELLED", superseded: false, capture })).toEqual({
      state: "awaiting-decision",
      recordCents: 0,
    });
    expect(
      decideLateCapture({ taskStatus: "COMPLETED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "refunded", recordCents: 0 });
    expect(
      decideLateCapture({ taskStatus: "DISMISSED", bookingStatus: "CANCELLED", superseded: false, capture }),
    ).toEqual({ state: "kept", recordCents: 24000 });
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CANCELLED", superseded: false, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: true, capture }).state).toBe(
      "refunded",
    );
    expect(decideLateCapture({ taskStatus: null, bookingStatus: "CONFIRMED", superseded: false, capture }).state).toBe(
      "kept",
    );
  });

  // #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit").
  it("MUTATION: an approved refund closed as paid another way is still refunded, but Xero owes the GROSS receipt", () => {
    expect(
      decideLateCapture({
        taskStatus: "COMPLETED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture,
        refundClosedPaidAnotherWay: true,
      }),
    ).toEqual({ state: "refunded", recordCents: 24000 });
    // Only an approval's close: an undecided task owes nothing yet.
    expect(
      decideLateCapture({ taskStatus: "OPEN", bookingStatus: "CANCELLED", superseded: false, capture, refundClosedPaidAnotherWay: true }),
    ).toEqual({ state: "awaiting-decision", recordCents: 0 });
    // And never a charge that was not taken.
    expect(
      decideLateCapture({
        taskStatus: "COMPLETED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture: { status: "FAILED", amountCents: 24000 },
        refundClosedPaidAnotherWay: true,
      }).recordCents,
    ).toBe(0);
  });

  it("records the GROSS capture, even one refunded since - the refund is its own note", () => {
    for (const status of ["PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        decideLateCapture({
          taskStatus: "DISMISSED",
          bookingStatus: "CANCELLED",
          superseded: false,
          capture: { status, amountCents: 24000 },
        }).recordCents,
      ).toBe(24000);
    }
    expect(
      decideLateCapture({
        taskStatus: "DISMISSED",
        bookingStatus: "CANCELLED",
        superseded: false,
        capture: { status: "FAILED", amountCents: 24000 },
      }).recordCents,
    ).toBe(0);
  });

  it("sends a change payment on an invoiced booking to its change's evidence, everything else to the kept invoice", () => {
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: true })).toBe(
      "by-change-evidence",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "ADDITIONAL", bookingHasPrimaryInvoice: false })).toBe(
      "kept-invoice",
    );
    expect(keptLateCaptureRecordRoute({ captureKind: "PRIMARY", bookingHasPrimaryInvoice: true })).toBe(
      "kept-invoice",
    );
  });

  it("counts a kept invoice row in any state but CANCELLED as already asked for", () => {
    for (const status of ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status }])).toBe(true);
    }
    expect(keptLateCaptureInvoiceAsked([{ queueType: "KEPT_LATE_CAPTURE_INVOICE", status: "CANCELLED" }])).toBe(
      false,
    );
  });
});

describe("planKeptLateCaptureXeroRecord", () => {
  it("queues the kept invoice for the gross cents dated the capture day, INSIDE the caller's transaction", async () => {
    await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith({
      manualRefundTaskId: "task_kept",
      bookingId: "booking-1",
      paymentIntentId: "pi_late",
      capturedCents: 24000,
      capturedOn: "2026-06-10",
      createdByMemberId: "treasurer-1",
      store,
    });
  });

  it("still queues the gross receipt for a capture refunded in the dashboard since", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "PRIMARY",
      status: "REFUNDED",
      amountCents: 24000,
      paymentId: "payment-1",
    });
    await plan();
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 24000 }),
    );
  });

  it("hands a kept change payment on an invoiced booking to the late-capture release", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: "inv_primary" });
    // #4324: one its change invoice answers - here, parked on its intent.
    mocks.operationFindMany.mockResolvedValueOnce([{ status: "WAITING_PAYMENT", lastErrorCode: null }]);
    await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });

  it("gives a kept change payment on a booking Xero never invoiced the kept invoice (review F3)", async () => {
    mocks.transactionFindUnique.mockResolvedValue({
      kind: "ADDITIONAL",
      status: "SUCCEEDED",
      amountCents: 2500,
      paymentId: "payment-1",
    });
    await expect(plan()).resolves.toMatchObject({ kind: "kept-invoice-queued" });
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
      expect.objectContaining({ capturedCents: 2500 }),
    );
  });

  it("does nothing for an intent with no recorded capture", async () => {
    mocks.transactionFindUnique.mockResolvedValue(null);
    await expect(plan()).resolves.toEqual({ kind: "none" });
  });

  it("#4324: takes the task row first and queues nothing for a task no longer kept (a stale repair snapshot)", async () => {
    mocks.taskFindUnique.mockResolvedValue({ createdAt: new Date("2026-06-10T01:00:00Z"), status: "OPEN" });
    await expect(plan()).resolves.toEqual({ kind: "none" });
    expect(mocks.lockKeptLateCaptureTask).toHaveBeenCalledWith(store, "task_kept");
    expect(mocks.lockKeptLateCaptureTask.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.taskFindUnique.mock.invocationCallOrder[0]!,
    );
    expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
  });
});

/**
 * #4324 (owner decision 25 Oct 2026, Q1 "split on the evidence";
 * `INV-PAY-141`): a kept CHANGE capture on a cancelled booking whose primary
 * invoice exists. The books each route produces are
 * `xero-kept-late-capture-ledger.test.ts`'s (e3, e4).
 */
describe("#4324: a kept change capture on an invoiced booking", () => {
  const evidence = (overrides: Partial<KeptChangeCaptureEvidence> = {}): KeptChangeCaptureEvidence => ({
    answeredByChangeInvoice: false,
    changeId: "mod_change",
    settledAgainstPrimary: false,
    changeInvoices: "none",
    ...overrides,
  });

  it("keptChangeCaptureRoute: one row per branch of the owner's split", () => {
    expect(keptChangeCaptureRoute(evidence({ answeredByChangeInvoice: true, changeInvoices: "withdrawn" }))).toBe("change-invoice");
    expect(keptChangeCaptureRoute(evidence({ answeredByChangeInvoice: true, changeId: null }))).toBe("change-invoice");
    expect(keptChangeCaptureRoute(evidence({ changeId: null }))).toBe("change-unknown");
    expect(keptChangeCaptureRoute(evidence({ settledAgainstPrimary: true, changeInvoices: "withdrawn" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "none" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "live" }))).toBe("receipt");
    expect(keptChangeCaptureRoute(evidence({ changeInvoices: "withdrawn" }))).toBe("kept-invoice");
  });

  describe("readKeptChangeCaptureEvidence: a change invoice answers the capture exactly where the release does not answer none-queued", () => {
    const read = (rows: Array<{ status: string; lastErrorCode: string | null }>) => {
      mocks.operationFindMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
      return readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change" });
    };
    for (const status of ["WAITING_PAYMENT", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "PARTIAL"]) {
      it(`a ${status} row naming the intent answers it (the release releases, reports or finds it)`, async () => {
        await expect(read([{ status, lastErrorCode: null }])).resolves.toMatchObject({ answeredByChangeInvoice: true });
      });
    }
    for (const code of ["STALE_WAITING_PAYMENT", "STALE_WAITING_PAYMENT_CAPTURED", "STALE_WAITING_PAYMENT_COVERED"]) {
      it(`MUTATION: a CANCELLED row stamped ${code} answers it (revived, alerted or covered)`, async () => {
        await expect(read([{ status: "CANCELLED", lastErrorCode: code }])).resolves.toMatchObject({ answeredByChangeInvoice: true });
      });
    }
    for (const code of ["KEPT_LATE_CAPTURE_WITHDRAWN", null]) {
      it(`a CANCELLED row stamped ${code} was withdrawn, and answers nothing`, async () => {
        await expect(read([{ status: "CANCELLED", lastErrorCode: code }])).resolves.toMatchObject({ answeredByChangeInvoice: false });
      });
    }

    it("reads the #3980 marker and the change's own invoices, never the gap invoice a marked edit anchors", async () => {
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      mocks.operationFindMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: "PENDING", requestPayload: { primaryInvoiceGap: true } }]);
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change" }),
      ).resolves.toEqual(evidence({ settledAgainstPrimary: true, changeInvoices: "none" }));
      expect(mocks.operationFindMany.mock.calls[1]![0]).toMatchObject({
        where: {
          queueType: "SUPPLEMENTARY_INVOICE",
          OR: [
            { localModel: "BookingModification", localId: "mod_change" },
            { requestPayload: { path: ["bookingModificationId"], equals: "mod_change" } },
          ],
        },
      });
    });

    it("reads the change's invoices as withdrawn only when every one is CANCELLED, and live where Xero has one linked", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change" }),
      ).resolves.toMatchObject({ changeInvoices: "withdrawn" });
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      mocks.linkFindFirst.mockResolvedValueOnce({ id: "link_change" });
      await expect(
        readKeptChangeCaptureEvidence(store as never, { paymentIntentId: "pi_late", changeId: "mod_change" }),
      ).resolves.toMatchObject({ changeInvoices: "live" });
    });
  });

  describe("planKeptLateCaptureXeroRecord", () => {
    beforeEach(() => {
      mocks.transactionFindUnique.mockResolvedValue({
        kind: "ADDITIONAL",
        status: "SUCCEEDED",
        amountCents: 8000,
        paymentId: "payment-1",
        bookingModificationId: "mod_change",
        reason: null,
      });
      mocks.paymentFindUnique.mockResolvedValue({ xeroInvoiceId: "inv_primary" });
    });

    it("hands it to the late-capture release where a change invoice answers it", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([{ status: "WAITING_PAYMENT", lastErrorCode: null }]).mockResolvedValue([]);
      await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    for (const code of ["STALE_WAITING_PAYMENT", "STALE_WAITING_PAYMENT_CAPTURED", "STALE_WAITING_PAYMENT_COVERED"]) {
      it(`MUTATION: a change invoice the reaper retired (${code}) still answers it, though every change row is CANCELLED - never a kept invoice`, async () => {
        const retired = { status: "CANCELLED", lastErrorCode: code, requestPayload: {} };
        mocks.operationFindMany.mockResolvedValueOnce([retired]).mockResolvedValueOnce([retired]);
        await expect(plan()).resolves.toEqual({ kind: "change-payment", paymentIntentId: "pi_late" });
        expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
        expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      });
    }

    it("MUTATION e3: queues its receipt on the caller's transaction where the primary bills the change, under the change's anchor after the task row", async () => {
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).toHaveBeenCalledWith("pi_late", {
        store,
        keptLateCapture: true,
        createdByMemberId: "treasurer-1",
      });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(store, "mod_change");
      const taskLock = mocks.lockKeptLateCaptureTask.mock.invocationCallOrder[0]!;
      const anchorLock = mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]!;
      expect(taskLock).toBeLessThan(anchorLock);
      expect(anchorLock).toBeLessThan(mocks.operationFindMany.mock.invocationCallOrder[0]!);
    });

    it("MUTATION e4: queues the kept invoice where the change's invoice was withdrawn, so nothing bills it", async () => {
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).toHaveBeenCalledWith(
        expect.objectContaining({ capturedCents: 8000, paymentIntentId: "pi_late" }),
      );
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
    });

    it("queues nothing where no change can be read from the capture, and locks the booking", async () => {
      mocks.transactionFindUnique.mockResolvedValue({
        kind: "ADDITIONAL",
        status: "SUCCEEDED",
        amountCents: 8000,
        paymentId: "payment-1",
        bookingModificationId: null,
        reason: null,
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(store, "booking-1");
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("MUTATION (INV-PAY-139): returns the capture's receipt already queued, whatever the evidence says now", async () => {
      mocks.operationFindFirst.mockResolvedValue({ id: "op_receipt_existing" });
      mocks.operationFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ status: "CANCELLED", requestPayload: {} }]);
      await expect(plan()).resolves.toEqual({ kind: "receipt-queued", queueOperationId: "op_receipt_existing" });
      expect(mocks.operationFindFirst).toHaveBeenCalledWith({
        where: { correlationKey: "receipt-key:pi_late", status: { not: "CANCELLED" } },
        select: { id: true },
      });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });

    it("MUTATION (INV-PAY-139): returns the capture's kept invoice already queued, never a receipt beside it", async () => {
      mocks.findLiveKeptReceiptRow.mockResolvedValue({ id: "op_kept" });
      mocks.modificationFindUnique.mockResolvedValue({
        newData: { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } },
      });
      await expect(plan()).resolves.toEqual({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
      expect(mocks.enqueueAdditionalCaptureReceiptOperation).not.toHaveBeenCalled();
    });

    it("records nothing where the receipt's enqueue finds another document records it", async () => {
      mocks.enqueueAdditionalCaptureReceiptOperation.mockResolvedValue({
        outcome: "not-eligible",
        reason: "recorded-by-supplementary-invoice",
      });
      await expect(plan()).resolves.toEqual({ kind: "none" });
      expect(mocks.enqueueXeroKeptLateCaptureInvoiceOperation).not.toHaveBeenCalled();
    });
  });
});

describe("finishKeptLateCaptureXeroRecord", () => {
  it("releases a kept change payment's invoice, credits back any refund already taken, and kicks the outbox", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" });
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).toHaveBeenCalledWith("pi_late");
    expect(mocks.creditBackLateCaptureRefunds).toHaveBeenCalledWith("pi_late");
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("#4324: kicks the outbox for a queued receipt, releasing nothing", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "receipt-queued", queueOperationId: "op_receipt" });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
    expect(mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent).not.toHaveBeenCalled();
  });

  it("kicks the outbox for a queued kept invoice", async () => {
    await finishKeptLateCaptureXeroRecord({ kind: "kept-invoice-queued", queueOperationId: "op_kept" });
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalledTimes(1);
  });

  it("never throws: the decision has already committed", async () => {
    mocks.releaseXeroSupplementaryInvoiceForCapturedPaymentIntent.mockRejectedValue(new Error("db down"));
    await expect(
      finishKeptLateCaptureXeroRecord({ kind: "change-payment", paymentIntentId: "pi_late" }),
    ).resolves.toBeUndefined();
  });
});
