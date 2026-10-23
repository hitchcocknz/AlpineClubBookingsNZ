/**
 * A BOOKING CHANGE'S CARD CAPTURE IS RECORDED AGAINST THE XERO INVOICE THAT
 * BILLS IT (#3953, `INV-PAY-138`; owner decision and plan, 21 Oct 2026: "check,
 * then bill and pay").
 *
 * A change made while the booking's primary invoice did not yet exist queues no
 * supplementary invoice: the primary is built later from the post-change price
 * and bills the extra itself. When the member pays that extra by card only after
 * the primary was raised, nothing waits on the capture
 * (`releaseXeroSupplementaryInvoiceForCapturedPaymentIntent` answers
 * `none-queued`), so the capture is queued here instead
 * (`enqueueAdditionalCaptureReceiptOperation`) and this worker records it, AT
 * CAPTURE TIME, against whatever invoice still has that money due:
 *
 *  1. THE GAP INVOICE FIRST. When an edit raced the primary invoice's create
 *     (#3980, `INV-PAY-136`), the primary bills the booking as it was before
 *     the edit and the gap's supplementary invoice bills the edit's extra. That
 *     invoice exists for exactly this money, so it is paid first.
 *  2. THEN THE PRIMARY INVOICE, the usual case: it was built from the
 *     post-change price, so it bills the extra and holds it due. Its room is its
 *     AmountDue less the applied account credit its settle still allocates
 *     there (`primaryInvoiceStripeCashCents`), so that allocation always fits.
 *
 * One invoice, never split: the capture's gross cents, capped at that invoice's
 * room. Cash it leaves over is told to an officer with both figures.
 *
 * NOTHING IS GUESSED. The worker refuses - the row FAILED with
 * `ADDITIONAL_CAPTURE_RECEIPT_REFUSED`, an officer told - where Xero cannot be
 * read, nothing is due on either invoice, the booking was cancelled (its
 * invoice is cleared by the cancellation's note), the gap invoice has not
 * reached Xero, or another writer's payment against the same invoice is still
 * owed (the primary's own Stripe payment, or the gap invoice's, after a
 * PARTIAL). It WAITS (back to PENDING) while the gap invoice is still being
 * sent. Where neither invoice can take the capture and no gap invoice exists,
 * the gap is raised through #3980's own check (`recheckPrimaryInvoiceWorthGap`),
 * which never queues a second.
 *
 * NEVER TWICE. One row per capture (its key names the intent), queued under the
 * per-anchor supplementary-invoice lock. The worker returns early on the
 * capture's own payment link; finds a payment an earlier run recorded by its
 * reference before writing another; stores the payment it decided on the row
 * BEFORE calling Xero, so a retry sends the same invoice, amount, date and Xero
 * key and never decides again; and leaves alone a capture the primary's create
 * already counted (`capturedPaymentIntentIdsAtBuild`).
 *
 * No provider call is made under a lock or inside a transaction (`INV-LOCK-004`).
 */
import type { Invoice } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { sendAdminXeroSyncErrorAlert } from "@/lib/email";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { createXeroPaymentForInvoice } from "@/lib/xero-invoice-payments";
import { readStripeCaptureDocumentDate } from "@/lib/stripe-capture-date";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { readXeroInvoiceOperationOutcome } from "@/lib/xero-booking-invoice-outcome";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { asRecord } from "@/lib/xero-json";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
} from "@/lib/xero-sync";
import {
  findPrimaryInvoiceGapInvoice,
  readPrimaryInvoiceFeeAtLink,
} from "@/lib/xero-primary-invoice-gap-anchors";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE } from "@/lib/additional-capture-receipt-link";
import {
  readAdditionalCaptureReceiptPayload,
  type AdditionalCaptureReceiptPlan,
  type AdditionalCaptureReceiptTarget,
} from "@/lib/additional-capture-receipt-payload";

/** Stamped on a row the worker refused: an officer checks Xero and records it by hand, or retries. */
export const ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE = "ADDITIONAL_CAPTURE_RECEIPT_REFUSED";

/** The outbox row's key: one per capture. */
export function additionalCaptureReceiptKey(paymentIntentId: string): string {
  return buildXeroIdempotencyKey("payment-intent", paymentIntentId, "additional-capture-receipt", "v1");
}

/** The Xero payment's key: the capture and the invoice it is recorded against. */
export function additionalCapturePaymentKey(paymentIntentId: string, invoiceId: string): string {
  return buildXeroIdempotencyKey("payment-intent", paymentIntentId, "additional-capture-payment", invoiceId, "v1");
}

/** The reference the payment is recorded under, as every Stripe payment the app records is. */
export function additionalCapturePaymentReference(paymentIntentId: string): string {
  return `Stripe ${paymentIntentId}`;
}

/** What one invoice can take of the capture, as Xero shows it now. */
export type ReceiptCandidate = {
  target: AdditionalCaptureReceiptTarget;
  invoiceId: string;
  /** Cents this capture may be recorded against; 0 when it can take none. */
  roomCents: number;
};

/**
 * THE ONE DECISION, pure: the first candidate with room, in the order given -
 * the gap invoice, then the primary - and the capture's gross cents capped at
 * that room. Null when none has any.
 */
export function chooseAdditionalCaptureReceiptTarget(
  capturedCents: number,
  candidates: readonly ReceiptCandidate[],
): { target: AdditionalCaptureReceiptTarget; invoiceId: string; amountCents: number } | null {
  if (!Number.isInteger(capturedCents) || capturedCents <= 0) return null;
  const chosen = candidates.find((candidate) => candidate.roomCents > 0);
  if (!chosen) return null;
  return {
    target: chosen.target,
    invoiceId: chosen.invoiceId,
    amountCents: Math.min(capturedCents, chosen.roomCents),
  };
}

/**
 * Raised while the gap invoice is still on its way to Xero. A busy error, so
 * the outbox returns this row to PENDING rather than failing it; the gap
 * invoice's row is older, so the next scan sends it first.
 */
export class AdditionalCaptureReceiptWaitError extends XeroAppliedCreditOperationBusyError {
  constructor(message: string) {
    super(message);
    this.name = "AdditionalCaptureReceiptWaitError";
  }
}

/**
 * Test seam: the worker's provider calls, so tests drive it without Xero or
 * Stripe. Production passes nothing.
 */
export interface AdditionalCaptureReceiptProviders {
  getAuthenticatedXeroClient: typeof getAuthenticatedXeroClient;
  callXeroApi: typeof callXeroApi;
  createXeroPaymentForInvoice: typeof createXeroPaymentForInvoice;
  readStripeCaptureDocumentDate: typeof readStripeCaptureDocumentDate;
}

const PROVIDERS: AdditionalCaptureReceiptProviders = {
  getAuthenticatedXeroClient,
  callXeroApi,
  createXeroPaymentForInvoice,
  readStripeCaptureDocumentDate,
};

const OUTSTANDING_STATUSES = new Set(["PENDING", "RUNNING", "WAITING_PAYMENT"]);

/**
 * WHY A ROW IS REFUSED, in the officer's words. Each names what to check; none
 * is retried automatically.
 */
const REFUSAL_TEXT = {
  "not-captured": "no captured card payment could be found for it",
  "booking-cancelled":
    "the booking has since been cancelled, and its cancellation clears the booking's Xero invoice",
  "no-primary-invoice": "the booking has no Xero invoice linked",
  "gap-invoice-not-in-xero":
    "the supplementary invoice that bills this change has not reached Xero (its operation failed or was resolved by hand)",
  "gap-review-task":
    "the booking's Xero invoice bills less than the booking is worth and no change explains it; a Xero Operations task asks the treasurer to bill it",
  "own-payment-pending":
    "the invoice's own card payment has not been recorded in Xero yet (its operation is PARTIAL); retry this once that is repaired",
  "nothing-due": "neither the booking's Xero invoice nor a supplementary invoice for the change has any amount still due",
  "figures-changed":
    "the invoice no longer has the amount due this payment was sized at when it was first tried",
} as const;
export type AdditionalCaptureReceiptRefusal = keyof typeof REFUSAL_TEXT;

async function alertOfficer(paymentIntentId: string, operationId: string, message: string): Promise<void> {
  try {
    await sendAdminXeroSyncErrorAlert({
      errorType: "ADDITIONAL_CAPTURE_NOT_RECORDED",
      operation: `Card payment ${paymentIntentId} for a booking change`,
      errorMessage: `${message} Stripe holds this money; check Xero records it (outbox operation ${operationId}).`,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error({ err, operationId }, "Failed to send the unrecorded card payment alert");
  }
}

type InvoiceRead = { status: string; amountDueCents: number; invoice: Invoice };

async function readInvoice(
  providers: AdditionalCaptureReceiptProviders,
  client: { xero: Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"]; tenantId: string },
  invoiceId: string,
): Promise<InvoiceRead | null> {
  const response = await providers.callXeroApi(
    () => client.xero.accountingApi.getInvoice(client.tenantId, invoiceId),
    {
      operation: "getInvoice",
      resourceType: "INVOICE",
      workflow: "recordAdditionalCaptureReceipt",
      context: `getInvoice(additional capture receipt ${invoiceId})`,
    },
  );
  const invoice = response.body.invoices?.[0];
  const amountDueCents = providerAmountToCents(invoice?.amountDue);
  if (!invoice || amountDueCents === null) return null;
  return { status: String(invoice.status ?? ""), amountDueCents, invoice };
}

/** An earlier run's payment of this capture on the invoice, found by its reference. */
function findRecordedPayment(read: InvoiceRead | null, reference: string) {
  return (
    (read?.invoice.payments ?? []).find(
      (payment) =>
        Boolean(payment.paymentID) &&
        payment.reference === reference &&
        String(payment.status ?? "").toUpperCase() !== "DELETED",
    ) ?? null
  );
}

function roomOn(read: InvoiceRead | null): number {
  return read && read.status === "AUTHORISED" ? Math.max(0, read.amountDueCents) : 0;
}

/** Whether a create's row says its own Stripe payment failed and is still owed (PARTIAL, payment fault). */
function ownPaymentPending(operation: { status: string; responsePayload: unknown } | null): boolean {
  return (
    operation?.status === "PARTIAL" &&
    readXeroInvoiceOperationOutcome(operation.responsePayload)?.paymentFailed === true
  );
}

/**
 * THE WORKER, from the outbox. Returns the Xero payment id it recorded or
 * found, or null when it recorded nothing.
 */
export async function recordAdditionalCaptureReceipt(
  params: { syncOperationId: string; createdByMemberId?: string },
  providers: AdditionalCaptureReceiptProviders = PROVIDERS,
): Promise<string | null> {
  const operationId = params.syncOperationId;
  const row = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
    select: { requestPayload: true },
  });
  const queued = readAdditionalCaptureReceiptPayload(row?.requestPayload);
  if (!queued) {
    throw new Error(`Card capture receipt operation ${operationId} has no readable queued payload`);
  }
  const { bookingId, paymentTransactionId, paymentIntentId } = queued;
  const reference = additionalCapturePaymentReference(paymentIntentId);

  const refuse = async (reason: AdditionalCaptureReceiptRefusal, details: Record<string, unknown> = {}) => {
    const message = `The card payment for this booking change was not recorded in Xero: ${REFUSAL_TEXT[reason]}.`;
    logger.error({ operationId, bookingId, paymentIntentId, reason, ...details }, message);
    await failXeroSyncOperation(operationId, new Error(message), { refused: reason, ...details }, {
      lastErrorMessage: message,
    });
    await prisma.xeroSyncOperation.updateMany({
      where: { id: operationId, status: "FAILED" },
      data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE },
    });
    await alertOfficer(paymentIntentId, operationId, message);
    return null;
  };

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "PaymentTransaction",
      localId: paymentTransactionId,
      xeroObjectType: "PAYMENT",
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      active: true,
    },
    select: { xeroObjectId: true, metadata: true },
  });
  if (existingLink) {
    await completeXeroSyncOperation(operationId, {
      responsePayload: { alreadyRecorded: true, paymentId: existingLink.xeroObjectId },
      xeroObjectType: "PAYMENT",
      xeroObjectId: existingLink.xeroObjectId,
    });
    return existingLink.xeroObjectId;
  }

  try {
    const plan = queued.plan ?? (await planReceipt());
    // No plan: the row is already finished - skipped, recorded, or refused.
    if (!plan) return null;
    return await sendPlannedPayment(plan, Boolean(queued.plan));
  } catch (error) {
    if (error instanceof XeroAppliedCreditOperationBusyError) throw error;
    await failXeroSyncOperation(operationId, error);
    throw error;
  }

  /**
   * Decide the payment, store it on the row, and return it; or finish the row
   * (skipped, recorded elsewhere, or refused) and return null.
   */
  async function planReceipt(): Promise<AdditionalCaptureReceiptPlan | null> {
    const transaction = await prisma.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      select: {
        kind: true,
        source: true,
        status: true,
        amountCents: true,
        stripePaymentIntentId: true,
        payment: {
          select: {
            id: true,
            source: true,
            status: true,
            amountCents: true,
            refundedAmountCents: true,
            creditAppliedCents: true,
            xeroInvoiceId: true,
            booking: { select: { status: true } },
          },
        },
      },
    });
    if (
      !transaction ||
      transaction.kind !== "ADDITIONAL" ||
      transaction.source !== "STRIPE" ||
      transaction.stripePaymentIntentId !== paymentIntentId ||
      !isCapturedTransactionStatus(transaction.status) ||
      transaction.amountCents <= 0
    ) {
      return refuse("not-captured");
    }
    const payment = transaction.payment;
    if (payment.booking.status === "CANCELLED") return refuse("booking-cancelled");
    const primaryInvoiceId = payment.xeroInvoiceId;
    if (!primaryInvoiceId) return refuse("no-primary-invoice");

    // Only a capture the club keeps is recorded; one refunded or awaiting a
    // treasurer is not. Imported here: that module reaches the outbox, which
    // dispatches to this worker.
    const { lateCaptureRefundState } = await import("@/lib/xero-supplementary-invoice-late-capture");
    const refundState = await lateCaptureRefundState({ paymentIntentId, bookingStatus: payment.booking.status });
    if (refundState !== "kept") {
      await completeXeroSyncOperation(operationId, {
        status: "CANCELLED",
        responsePayload: { skipped: "capture-not-kept", refundState },
      });
      return null;
    }

    const stored = await readPrimaryInvoiceFeeAtLink(bookingId, primaryInvoiceId);
    if (stored?.atLink.capturedPaymentIntentIdsAtBuild?.includes(paymentIntentId)) {
      // The primary's create counted this capture in the cash it recorded (or
      // left to its gap invoice); it is that create's, never this row's.
      await completeXeroSyncOperation(operationId, {
        responsePayload: { skipped: "counted-by-primary-invoice", primaryInvoiceId },
      });
      return null;
    }

    const gap = stored ? await findPrimaryInvoiceGapInvoice(bookingId, stored) : null;
    if (gap?.operation && OUTSTANDING_STATUSES.has(gap.operation.status)) {
      throw new AdditionalCaptureReceiptWaitError(
        `The supplementary invoice for this booking's change (operation ${gap.operation.id}) is still on its way to Xero; this card payment is recorded once it is there`,
      );
    }
    const gapInvoiceId = gap?.link?.active ? gap.link.xeroObjectId : null;
    if (gap && !gapInvoiceId) return refuse("gap-invoice-not-in-xero", { gapOperationId: gap.operation?.id ?? null });

    const primaryCreate = await prisma.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
        xeroObjectId: primaryInvoiceId,
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, responsePayload: true },
    });
    const gapRecordsItsOwnPayment = asRecord(gap?.operation?.requestPayload)?.recordPayment === true;
    if (ownPaymentPending(primaryCreate) || (gapRecordsItsOwnPayment && ownPaymentPending(gap?.operation ?? null))) {
      return refuse("own-payment-pending");
    }

    const client = await providers.getAuthenticatedXeroClient();
    const [gapRead, primaryRead] = await Promise.all([
      gapInvoiceId ? readInvoice(providers, client, gapInvoiceId) : Promise.resolve(null),
      readInvoice(providers, client, primaryInvoiceId),
    ]);
    if (!primaryRead || (gapInvoiceId && !gapRead)) {
      return refuse("nothing-due", { unreadable: true, primaryInvoiceId, gapInvoiceId });
    }

    // A lost response: an earlier run recorded it, and only its link is missing.
    for (const [read, target, invoiceId] of [
      [gapRead, "GAP_INVOICE", gapInvoiceId],
      [primaryRead, "PRIMARY_INVOICE", primaryInvoiceId],
    ] as const) {
      const recorded = findRecordedPayment(read, reference);
      if (recorded?.paymentID && invoiceId) {
        await finishRecorded({
          paymentId: recorded.paymentID,
          plan: {
            target,
            invoiceId,
            amountCents: providerAmountToCents(recorded.amount) ?? transaction.amountCents,
            capturedCents: transaction.amountCents,
            date: String(recorded.date ?? ""),
          },
          recoveredExisting: true,
        });
        return null;
      }
    }

    const { cardSettleAppliedCreditCents, primaryInvoiceStripeCashCents } = await import(
      "@/lib/xero-primary-invoice-fee-gap"
    );
    const capturedCents = transaction.amountCents;
    const candidates: ReceiptCandidate[] = [
      ...(gapInvoiceId ? [{ target: "GAP_INVOICE" as const, invoiceId: gapInvoiceId, roomCents: roomOn(gapRead) }] : []),
      {
        target: "PRIMARY_INVOICE",
        invoiceId: primaryInvoiceId,
        roomCents:
          primaryRead.status === "AUTHORISED"
            ? primaryInvoiceStripeCashCents({
                netCapturedCents: capturedCents,
                amountDueCents: primaryRead.amountDueCents,
                appliedCreditCents: await cardSettleAppliedCreditCents(bookingId, payment),
              })
            : 0,
      },
    ];
    const chosen = chooseAdditionalCaptureReceiptTarget(capturedCents, candidates);

    if (!gap && (!chosen || chosen.amountCents < capturedCents)) {
      // Neither invoice takes all of it and no gap invoice exists: the primary
      // may bill less than the booking was worth at its link. #3980's own check
      // raises that gap, or finds it raised, and never queues a second.
      const { recheckPrimaryInvoiceWorthGap } = await import("@/lib/xero-primary-invoice-fee-gap");
      const recheck = await recheckPrimaryInvoiceWorthGap({
        bookingId,
        xeroInvoiceId: primaryInvoiceId,
        createdByMemberId: params.createdByMemberId,
      });
      if (recheck.queueOperationId && !recheck.alreadyQueued && recheck.cashTakenCents > 0) {
        // Raised now, paid from the cash the primary left - this capture's.
        await completeXeroSyncOperation(operationId, {
          responsePayload: { recordedByGapInvoice: recheck.queueOperationId, gapCents: recheck.gapCents },
        });
        return null;
      }
      if (recheck.queueOperationId) {
        throw new AdditionalCaptureReceiptWaitError(
          `The supplementary invoice for this booking's gap (operation ${recheck.queueOperationId}) was queued; this card payment is recorded once it is in Xero`,
        );
      }
      if (recheck.reviewOperationId && !chosen) {
        return refuse("gap-review-task", { reviewOperationId: recheck.reviewOperationId });
      }
    }
    if (!chosen) return refuse("nothing-due", { primaryInvoiceId, gapInvoiceId, capturedCents });

    const zone = await readClubTimeZoneOutsideRequest();
    const date =
      (await providers.readStripeCaptureDocumentDate(paymentIntentId, zone)) ?? xeroDocumentDateForClubToday(zone);
    const plan: AdditionalCaptureReceiptPlan = { ...chosen, capturedCents, date };
    // Stored BEFORE the Xero call: a retry sends this, and never decides again.
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: { requestPayload: sanitizeForJson({ ...(asRecord(row?.requestPayload) ?? {}), plan }) },
    });
    return plan;
  }

  async function sendPlannedPayment(plan: AdditionalCaptureReceiptPlan, fromStore: boolean): Promise<string | null> {
    if (fromStore) {
      // A retry: an earlier run may have recorded it and lost the reply, or
      // the invoice may have changed since. Never decided again.
      const client = await providers.getAuthenticatedXeroClient();
      const read = await readInvoice(providers, client, plan.invoiceId);
      const recorded = findRecordedPayment(read, reference);
      if (recorded?.paymentID) {
        await finishRecorded({ paymentId: recorded.paymentID, plan, recoveredExisting: true });
        return recorded.paymentID;
      }
      if (roomOn(read) < plan.amountCents) {
        return refuse("figures-changed", { plan, amountDueCents: read?.amountDueCents ?? null });
      }
    }
    const paymentId = await providers.createXeroPaymentForInvoice({
      localModel: "PaymentTransaction",
      localId: paymentTransactionId,
      invoiceId: plan.invoiceId,
      amountCents: plan.amountCents,
      idempotencyKey: additionalCapturePaymentKey(paymentIntentId, plan.invoiceId),
      reference,
      role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
      createdByMemberId: params.createdByMemberId,
      metadata: { invoiceId: plan.invoiceId, target: plan.target, amountCents: plan.amountCents, paymentIntentId },
      date: plan.date,
    });
    await finishRecorded({ paymentId, plan, recoveredExisting: false });
    return paymentId;
  }

  async function finishRecorded(input: {
    paymentId: string;
    plan: AdditionalCaptureReceiptPlan;
    recoveredExisting: boolean;
  }): Promise<void> {
    const { plan } = input;
    const unrecordedCents = Math.max(0, plan.capturedCents - plan.amountCents);
    await completeXeroSyncOperation(operationId, {
      responsePayload: { paymentId: input.paymentId, plan, recoveredExisting: input.recoveredExisting, unrecordedCents },
      xeroObjectType: "PAYMENT",
      xeroObjectId: input.paymentId,
      xeroObjectUrl: buildXeroInvoiceUrl(plan.invoiceId),
      extraLinks: [
        {
          localModel: "PaymentTransaction",
          localId: paymentTransactionId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: input.paymentId,
          role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
          metadata: { invoiceId: plan.invoiceId, target: plan.target, amountCents: plan.amountCents, paymentIntentId },
        },
      ],
    });
    if (unrecordedCents > 0) {
      const format = await clubFormatValues();
      const message = `A card payment for a booking change was recorded in Xero for ${formatCents(plan.amountCents, format)} of the ${formatCents(plan.capturedCents, format)} captured: the invoice it was recorded against (${plan.invoiceId}) had no more due. The remaining ${formatCents(unrecordedCents, format)} is not on any Xero invoice.`;
      logger.error({ operationId, bookingId, paymentIntentId, plan, unrecordedCents }, message);
      await alertOfficer(paymentIntentId, operationId, message);
    }
  }
}
