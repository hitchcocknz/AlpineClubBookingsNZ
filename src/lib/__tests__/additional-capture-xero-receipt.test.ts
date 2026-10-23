/**
 * #3953 (`INV-PAY-138`): a booking change's card capture that no supplementary
 * invoice waited on is recorded against the Xero invoice that bills it - the
 * gap invoice first, then the primary - capped at what Xero shows due, once,
 * and refused with an officer told wherever the figures do not fit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findFirstOperation: vi.fn(),
  updateOperation: vi.fn(),
  updateManyOperation: vi.fn(),
  findFirstLink: vi.fn(),
  findUniqueTransaction: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn(),
  readPrimaryInvoiceFeeAtLink: vi.fn(),
  findPrimaryInvoiceGapInvoice: vi.fn(),
  lateCaptureRefundState: vi.fn(),
  cardSettleAppliedCreditCents: vi.fn(),
  recheckPrimaryInvoiceWorthGap: vi.fn(),
  lockSupplementaryInvoiceAnchor: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
      findFirst: mocks.findFirstOperation,
      update: mocks.updateOperation,
      updateMany: mocks.updateManyOperation,
    },
    xeroObjectLink: { findFirst: mocks.findFirstLink },
    paymentTransaction: { findUnique: mocks.findUniqueTransaction },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn().mockResolvedValue("Pacific/Auckland"),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: vi.fn().mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ" }),
}));
vi.mock("@/lib/utils", () => ({ formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}` }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
}));
vi.mock("@/lib/xero-primary-invoice-gap-anchors", () => ({
  readPrimaryInvoiceFeeAtLink: mocks.readPrimaryInvoiceFeeAtLink,
  findPrimaryInvoiceGapInvoice: mocks.findPrimaryInvoiceGapInvoice,
}));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  lateCaptureRefundState: mocks.lateCaptureRefundState,
}));
vi.mock("@/lib/xero-primary-invoice-fee-gap", () => ({
  cardSettleAppliedCreditCents: mocks.cardSettleAppliedCreditCents,
  // The real cap, so the applied credit's reservation is exercised here.
  primaryInvoiceStripeCashCents: (input: { netCapturedCents: number; amountDueCents: number | null; appliedCreditCents: number }) =>
    input.amountDueCents === null
      ? input.netCapturedCents
      : Math.max(0, Math.min(input.netCapturedCents, input.amountDueCents - input.appliedCreditCents)),
  recheckPrimaryInvoiceWorthGap: mocks.recheckPrimaryInvoiceWorthGap,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  lockSupplementaryInvoiceAnchor: mocks.lockSupplementaryInvoiceAnchor,
}));

import {
  ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE,
  AdditionalCaptureReceiptWaitError,
  chooseAdditionalCaptureReceiptTarget,
  recordAdditionalCaptureReceipt,
  type AdditionalCaptureReceiptProviders,
} from "@/lib/additional-capture-xero-receipt";
import { enqueueAdditionalCaptureReceiptOperation } from "@/lib/additional-capture-receipt-enqueue";
import { readAdditionalCaptureReceiptPayload } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE } from "@/lib/additional-capture-receipt-link";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const GAP = "22222222-2222-4222-8222-222222222222";
const PAYLOAD = {
  queueType: "ADDITIONAL_CAPTURE_RECEIPT",
  bookingId: "booking_1",
  paymentId: "payment_1",
  paymentTransactionId: "ptx_1",
  paymentIntentId: "pi_change",
};

/** `amountDue` in cents here; Xero sends major units, so the fake divides. */
type InvoiceState = { status?: string; amountDue: number; payments?: Array<Record<string, unknown>> };
let invoices: Record<string, InvoiceState>;
let order: string[];

function providers(): AdditionalCaptureReceiptProviders & { createXeroPaymentForInvoice: ReturnType<typeof vi.fn> } {
  return {
    getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
      tenantId: "tenant_1",
      xero: {
        accountingApi: {
          getInvoice: vi.fn(async (_tenant: string, id: string) => {
            const state = invoices[id];
            return {
              body: {
                invoices: state
                  ? [{ invoiceID: id, status: state.status ?? "AUTHORISED", amountDue: state.amountDue / 100, payments: state.payments ?? [] }]
                  : [],
              },
            };
          }),
        },
      },
    }),
    callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()) as never,
    createXeroPaymentForInvoice: vi.fn(async () => {
      order.push("createPayment");
      return "xero_payment_1";
    }),
    readStripeCaptureDocumentDate: vi.fn().mockResolvedValue("2026-06-30"),
  };
}

function capture(overrides: Record<string, unknown> = {}, booking = "CONFIRMED") {
  return {
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "SUCCEEDED",
    amountCents: 8000,
    stripePaymentIntentId: "pi_change",
    payment: {
      id: "payment_1",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 38000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      xeroInvoiceId: PRIMARY,
      booking: { status: booking },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  order = [];
  invoices = { [PRIMARY]: { amountDue: 8000 } };
  mocks.findUniqueOperation.mockResolvedValue({ requestPayload: PAYLOAD });
  mocks.findFirstLink.mockResolvedValue(null);
  mocks.findUniqueTransaction.mockResolvedValue(capture());
  mocks.lateCaptureRefundState.mockResolvedValue("kept");
  mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
    operationId: "op_primary",
    atLink: { xeroInvoiceId: PRIMARY, capturedPaymentIntentIdsAtBuild: ["pi_primary"] },
  });
  mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue(null);
  mocks.findFirstOperation.mockResolvedValue({ status: "SUCCEEDED", responsePayload: {} });
  mocks.cardSettleAppliedCreditCents.mockResolvedValue(0);
  mocks.recheckPrimaryInvoiceWorthGap.mockResolvedValue({
    gapCents: 0,
    queueOperationId: null,
    alreadyQueued: false,
    cashTakenCents: 0,
    reviewOperationId: null,
  });
  mocks.updateOperation.mockImplementation(async () => {
    order.push("storePlan");
    return {};
  });
  mocks.updateManyOperation.mockResolvedValue({ count: 1 });
});

const run = (seam = providers()) => recordAdditionalCaptureReceipt({ syncOperationId: "op_receipt" }, seam);
const storedPlan = () => mocks.updateOperation.mock.calls[0]?.[0]?.data?.requestPayload?.plan;
const expectRefused = (reason: string) => {
  expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
    "op_receipt",
    expect.any(Error),
    expect.objectContaining({ refused: reason }),
    expect.objectContaining({ lastErrorMessage: expect.stringContaining("was not recorded in Xero") }),
  );
  expect(mocks.updateManyOperation).toHaveBeenCalledWith({
    where: { id: "op_receipt", status: "FAILED" },
    data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE },
  });
  expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
};

describe("chooseAdditionalCaptureReceiptTarget", () => {
  it("takes the gap invoice first, then the primary, capped at the room", () => {
    expect(
      chooseAdditionalCaptureReceiptTarget(8000, [
        { target: "GAP_INVOICE", invoiceId: GAP, roomCents: 8000 },
        { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 8000 },
      ]),
    ).toEqual({ target: "GAP_INVOICE", invoiceId: GAP, amountCents: 8000 });
    expect(
      chooseAdditionalCaptureReceiptTarget(8000, [
        { target: "GAP_INVOICE", invoiceId: GAP, roomCents: 0 },
        { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 5000 },
      ]),
    ).toEqual({ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 5000 });
  });

  it("chooses nothing where no invoice has room or nothing was captured", () => {
    expect(chooseAdditionalCaptureReceiptTarget(8000, [{ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 0 }])).toBeNull();
    expect(chooseAdditionalCaptureReceiptTarget(0, [{ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 100 }])).toBeNull();
  });
});

describe("recordAdditionalCaptureReceipt", () => {
  it("records the capture against the primary invoice that bills it, its decision stored before Xero is asked", async () => {
    const seam = providers();

    await expect(run(seam)).resolves.toBe("xero_payment_1");

    expect(order).toEqual(["storePlan", "createPayment"]);
    expect(storedPlan()).toEqual({
      target: "PRIMARY_INVOICE",
      invoiceId: PRIMARY,
      amountCents: 8000,
      capturedCents: 8000,
      date: "2026-06-30",
    });
    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "PaymentTransaction",
        localId: "ptx_1",
        invoiceId: PRIMARY,
        amountCents: 8000,
        idempotencyKey: `payment-intent:pi_change:additional-capture-payment:${PRIMARY}:v1`,
        reference: "Stripe pi_change",
        role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
        date: "2026-06-30",
      }),
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_receipt",
      expect.objectContaining({
        xeroObjectType: "PAYMENT",
        xeroObjectId: "xero_payment_1",
        extraLinks: [expect.objectContaining({ role: ADDITIONAL_CAPTURE_PAYMENT_ROLE, localId: "ptx_1" })],
      }),
    );
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });

  it("records it against the #3980 gap invoice first, when that one has the money due", async () => {
    invoices[GAP] = { amountDue: 8000 };
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue({
      operation: { id: "op_gap", status: "SUCCEEDED", requestPayload: { recordPayment: false }, responsePayload: {} },
      link: { id: "link_gap", xeroObjectId: GAP, active: true },
    });
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: GAP, amountCents: 8000 }),
    );
    expect(storedPlan()).toEqual(expect.objectContaining({ target: "GAP_INVOICE" }));
    expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
  });

  it("leaves room on the primary for the applied credit its settle still allocates there", async () => {
    invoices[PRIMARY] = { amountDue: 10000 };
    mocks.cardSettleAppliedCreditCents.mockResolvedValue(4000);
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 6000 }));
    // The 20.00 the invoice could not take is told to an officer, with both figures.
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("$20.00") }),
    );
  });

  it("waits, failing nothing, while the gap invoice is still on its way to Xero", async () => {
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue({
      operation: { id: "op_gap", status: "PENDING", requestPayload: {}, responsePayload: null },
      link: null,
    });
    const seam = providers();

    await expect(run(seam)).rejects.toBeInstanceOf(AdditionalCaptureReceiptWaitError);

    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("never records a capture the primary invoice's create already counted", async () => {
    mocks.readPrimaryInvoiceFeeAtLink.mockResolvedValue({
      operationId: "op_primary",
      atLink: { xeroInvoiceId: PRIMARY, capturedPaymentIntentIdsAtBuild: ["pi_primary", "pi_change"] },
    });
    const seam = providers();

    await expect(run(seam)).resolves.toBeNull();

    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith("op_receipt", {
      responsePayload: { skipped: "counted-by-primary-invoice", primaryInvoiceId: PRIMARY },
    });
  });

  it("returns at once, and writes nothing to Xero, when the capture's payment is already linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ xeroObjectId: "xero_payment_earlier", metadata: {} });
    const seam = providers();

    await expect(run(seam)).resolves.toBe("xero_payment_earlier");

    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.findUniqueTransaction).not.toHaveBeenCalled();
  });

  it("links the payment an earlier run recorded, found by its reference, rather than recording a second", async () => {
    invoices[PRIMARY] = {
      amountDue: 0,
      payments: [{ paymentID: "xero_payment_lost", reference: "Stripe pi_change", amount: 80, status: "AUTHORISED" }],
    };
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      "op_receipt",
      expect.objectContaining({ xeroObjectId: "xero_payment_lost" }),
    );
  });

  it("refuses, and tells an officer, a capture on a booking since cancelled", async () => {
    mocks.findUniqueTransaction.mockResolvedValue(capture({}, "CANCELLED"));
    const seam = providers();

    await expect(run(seam)).resolves.toBeNull();

    expectRefused("booking-cancelled");
    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("refuses while the primary invoice's own card payment is still owed (its create PARTIAL)", async () => {
    mocks.findFirstOperation.mockResolvedValue({ status: "PARTIAL", responsePayload: { paymentError: { message: "x" } } });
    const seam = providers();

    await run(seam);

    expectRefused("own-payment-pending");
    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("refuses a gap invoice that never reached Xero", async () => {
    mocks.findPrimaryInvoiceGapInvoice.mockResolvedValue({
      operation: { id: "op_gap", status: "FAILED", requestPayload: {}, responsePayload: null },
      link: null,
    });

    await run();

    expectRefused("gap-invoice-not-in-xero");
  });

  it("with nothing due and no gap invoice, asks #3980's check, and refuses when it finds no gap", async () => {
    invoices[PRIMARY] = { amountDue: 0 };
    const seam = providers();

    await run(seam);

    expect(mocks.recheckPrimaryInvoiceWorthGap).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking_1", xeroInvoiceId: PRIMARY }),
    );
    expectRefused("nothing-due");
    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("finishes without a payment when #3980's check raises the gap now, paid from this capture's cash", async () => {
    invoices[PRIMARY] = { amountDue: 0 };
    mocks.recheckPrimaryInvoiceWorthGap.mockResolvedValue({
      gapCents: 8000,
      queueOperationId: "op_gap_new",
      alreadyQueued: false,
      cashTakenCents: 8000,
      reviewOperationId: null,
    });
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith("op_receipt", {
      responsePayload: { recordedByGapInvoice: "op_gap_new", gapCents: 8000 },
    });
  });

  it("waits for a gap invoice #3980's check raised unpaid, then records against it", async () => {
    invoices[PRIMARY] = { amountDue: 0 };
    mocks.recheckPrimaryInvoiceWorthGap.mockResolvedValue({
      gapCents: 8000,
      queueOperationId: "op_gap_new",
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });

    await expect(run()).rejects.toBeInstanceOf(AdditionalCaptureReceiptWaitError);
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("closes the row unsent for a capture the club does not keep", async () => {
    mocks.lateCaptureRefundState.mockResolvedValue("refunded");
    const seam = providers();

    await run(seam);

    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith("op_receipt", {
      status: "CANCELLED",
      responsePayload: { skipped: "capture-not-kept", refundState: "refunded" },
    });
    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  describe("a retry, with the decision stored", () => {
    const plan = { target: "GAP_INVOICE", invoiceId: GAP, amountCents: 8000, capturedCents: 8000, date: "2026-06-30" };
    beforeEach(() => {
      mocks.findUniqueOperation.mockResolvedValue({ requestPayload: { ...PAYLOAD, plan } });
    });

    it("sends the same invoice, amount, date and Xero key, never deciding again", async () => {
      invoices[GAP] = { amountDue: 8000 };
      const seam = providers();

      await run(seam);

      expect(mocks.findUniqueTransaction).not.toHaveBeenCalled();
      expect(mocks.updateOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: GAP,
          amountCents: 8000,
          date: "2026-06-30",
          idempotencyKey: `payment-intent:pi_change:additional-capture-payment:${GAP}:v1`,
        }),
      );
    });

    it("links what the first try recorded, if Xero has it", async () => {
      invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
      const seam = providers();

      await expect(run(seam)).resolves.toBe("xero_payment_first");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("refuses, rather than choosing another invoice, when that invoice no longer has it due", async () => {
      invoices[GAP] = { amountDue: 3000 };
      const seam = providers();

      await run(seam);

      expectRefused("figures-changed");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });
  });

  it("fails the row on a Xero write error, and keeps the stored decision for the retry", async () => {
    const seam = providers();
    seam.createXeroPaymentForInvoice.mockRejectedValueOnce(new Error("Xero 500"));

    await expect(run(seam)).rejects.toThrow("Xero 500");

    expect(storedPlan()).toEqual(expect.objectContaining({ invoiceId: PRIMARY }));
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith("op_receipt", expect.objectContaining({ message: "Xero 500" }));
  });
});

describe("readAdditionalCaptureReceiptPayload", () => {
  it("refuses a payload whose stored decision does not parse, so a retry never decides again", () => {
    expect(readAdditionalCaptureReceiptPayload(PAYLOAD)).toEqual(PAYLOAD);
    expect(readAdditionalCaptureReceiptPayload({ ...PAYLOAD, plan: { target: "PRIMARY_INVOICE" } })).toBeNull();
    expect(
      readAdditionalCaptureReceiptPayload({
        ...PAYLOAD,
        plan: { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 9000, capturedCents: 8000, date: "2026-06-30" },
      }),
    ).toBeNull();
  });
});

describe("enqueueAdditionalCaptureReceiptOperation", () => {
  const tx = {
    xeroSyncOperation: { findFirst: vi.fn() },
  };
  beforeEach(() => {
    tx.xeroSyncOperation.findFirst.mockReset();
    mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
    mocks.findUniqueTransaction.mockResolvedValue({
      id: "ptx_1",
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      bookingModificationId: "mod_1",
      payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: PRIMARY },
    });
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_receipt" });
  });

  it("queues one row per capture under the change's supplementary-invoice anchor lock", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({
      outcome: "queued",
      queueOperationId: "op_receipt",
    });

    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(tx, "mod_1");
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "PAYMENT",
        localModel: "PaymentTransaction",
        localId: "ptx_1",
        status: "PENDING",
        correlationKey: "payment-intent:pi_change:additional-capture-receipt:v1",
        idempotencyKey: "payment-intent:pi_change:additional-capture-receipt:v1",
        requestPayload: PAYLOAD,
        store: tx,
      }),
    );
  });

  it("finds the row the webhook or the confirm route queued first, and queues no second", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op_first" });

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({
      outcome: "already-queued",
      queueOperationId: "op_first",
    });
    expect(tx.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { correlationKey: "payment-intent:pi_change:additional-capture-receipt:v1", status: { not: "CANCELLED" } },
      }),
    );
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("locks the booking where the ledger row names no change", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.findUniqueTransaction.mockResolvedValue({
      id: "ptx_1",
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      bookingModificationId: null,
      payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: PRIMARY },
    });

    await enqueueAdditionalCaptureReceiptOperation("pi_change");
    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(tx, "booking_1");
  });

  it.each([
    ["the booking's own payment", { kind: "PRIMARY" }, "not-a-change-card-capture"],
    ["an uncaptured ask", { status: "PENDING" }, "not-a-change-card-capture"],
    ["a booking Xero never invoiced", { payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: null } }, "no-primary-invoice"],
  ])("queues nothing for %s", async (_label, overrides, reason) => {
    mocks.findUniqueTransaction.mockResolvedValue({
      id: "ptx_1",
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      bookingModificationId: "mod_1",
      payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: PRIMARY },
      ...overrides,
    });

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({ outcome: "not-eligible", reason });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
