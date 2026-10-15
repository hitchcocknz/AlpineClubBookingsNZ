import { PaymentSource } from "@prisma/client";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  buildLateCaptureRefundMetadata,
  buildLateCaptureRefundStripeKeyPrefix,
  LATE_CAPTURE_REFUND_METADATA_REASON,
} from "@/lib/payment-recovery-keys";
import {
  captureRefundState,
  isCapturedTransactionStatus,
  isRefusedRefundStatus,
} from "@/lib/payment-transaction-status";
import { refundPaymentTransactions, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";

/**
 * #4131 (`INV-PAY-106`, `INV-PAY-110`): A LATE CAPTURE IS REFUNDED FROM ITS OWN
 * CHARGE, never another of the booking's. Every late-capture refund door pins
 * its one slice here: both webhook handlers and the treasurer's approval.
 *
 * Why: the capture's refund is noted in Xero per capture, from the refunds made
 * on its own intent (`noteLateCaptureRefunds`), and the note-eligible cash
 * leaves out the refunds of a capture Xero never received by that intent
 * (`resolveRefundNoteEligibleCash`). A slice on another charge escaped both: no
 * note answered it when the capture had a receipt, and the nightly self-heal
 * raised one against the booking's own invoice when it had none.
 *
 * Capped at what the capture still holds. A refund already made on it (the
 * Stripe dashboard) was the member's money going back already, so the rest is
 * never moved onto another charge; the caller reports what was not asked for.
 */
export function lateCaptureOwnChargeSlice(
  capture: { id: string; status: Parameters<typeof captureRefundState>[0]["status"]; amountCents: number; refundedAmountCents: number },
  askedCents: number,
): { slice: RefundAllocationSlice; shortCents: number } {
  const amountCents = Math.max(0, Math.min(askedCents, captureRefundState(capture).heldCents));
  return { slice: { paymentTransactionId: capture.id, amountCents }, shortCents: Math.max(0, askedCents - amountCents) };
}

export interface AutomaticLateCaptureRefundPlan {
  /** The one slice to send, on the capture's own charge; empty when nothing is left to send. */
  allocation: RefundAllocationSlice[];
  /**
   * DEPLOY REPLAY: what an attempt by the pre-#4131 code, whose newest-first
   * plan could take a slice from a newer charge, already refunded there. The
   * capture's own slice is what is left, which is the slice that attempt asked
   * for and so its own Stripe key: Stripe answers it with the refund that
   * attempt made, never a second.
   */
  refundedElsewhereCents: number;
  /** What the capture no longer held: refunded on it already, so never asked for. */
  alreadyRefundedOnCaptureCents: number;
}

/**
 * The webhook's automatic refund of a late capture, planned on its own charge
 * (`lateCaptureOwnChargeSlice`).
 *
 * The automatic refund persists no plan: a crash or a 500 is replayed by
 * Stripe's redelivery, which plans again. An attempt made before this change
 * may have refunded a slice on a NEWER charge of the payment (its plan was
 * newest-first, and the capture's own row was never refunded or the notice
 * would be acknowledged, `acknowledgeSettledLateNotice`). Those refunds carry
 * this booking's late-capture metadata (`buildLateCaptureRefundMetadata`) on a
 * charge that is not itself a late capture, which nothing else writes since
 * every door pins its own capture. They are read from Stripe, so one made but
 * never recorded counts too; refused ones sent nothing back and do not count.
 * Only charges newer than the capture's row are read, the only ones that plan
 * could reach first, so a payment with one charge makes no Stripe call.
 *
 * Throws when the capture's row is missing or not captured: the handler wrote
 * it just before, so the webhook answers 500 and Stripe redelivers.
 */
export async function planAutomaticLateCaptureRefund(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}): Promise<AutomaticLateCaptureRefundPlan> {
  const capture = await prisma.paymentTransaction.findUnique({
    where: { stripePaymentIntentId: params.paymentIntentId },
    select: { id: true, paymentId: true, status: true, amountCents: true, refundedAmountCents: true, createdAt: true },
  });
  if (!capture || capture.paymentId !== params.paymentId || !isCapturedTransactionStatus(capture.status)) {
    throw new Error(
      `Late capture ${params.paymentIntentId} has no captured transaction on payment ${params.paymentId}; its refund waits for Stripe's redelivery`,
    );
  }
  const refundedElsewhereCents = Math.min(
    params.amountCents,
    await readPreviousPlanRefundsOnNewerCharges({ ...params, captureId: capture.id, captureCreatedAt: capture.createdAt }),
  );
  const owedCents = params.amountCents - refundedElsewhereCents;
  const { slice, shortCents } = lateCaptureOwnChargeSlice(capture, owedCents);
  return {
    allocation: slice.amountCents > 0 ? [slice] : [],
    refundedElsewhereCents,
    alreadyRefundedOnCaptureCents: shortCents,
  };
}

async function readPreviousPlanRefundsOnNewerCharges(params: {
  bookingId: string;
  paymentId: string;
  captureId: string;
  captureCreatedAt: Date;
}): Promise<number> {
  const newer = (
    await prisma.paymentTransaction.findMany({
      where: {
        paymentId: params.paymentId,
        source: PaymentSource.STRIPE,
        id: { not: params.captureId },
        createdAt: { gt: params.captureCreatedAt },
        stripePaymentIntentId: { not: null },
      },
      select: { stripePaymentIntentId: true, status: true },
    })
  ).filter((row) => isCapturedTransactionStatus(row.status));
  const intents = newer.map((row) => row.stripePaymentIntentId as string);
  if (intents.length === 0) return 0;
  // A late capture's own refunds are its own, whichever door made them.
  const lateCaptures = await findLateCapturePaymentIntents(intents);
  let cents = 0;
  for (const intent of intents) {
    if (lateCaptures.has(intent)) continue;
    for (const refund of await listRefundsForPaymentIntent(intent)) {
      if (
        refund.metadata?.reason === LATE_CAPTURE_REFUND_METADATA_REASON &&
        refund.metadata?.bookingId === params.bookingId &&
        !isRefusedRefundStatus(refund.status)
      ) {
        cents += refund.amount;
      }
    }
  }
  return cents;
}

/**
 * The primary webhook handler's automatic refund of a late capture: planned on
 * its own charge (`planAutomaticLateCaptureRefund`), sent under the late-capture
 * Stripe key and body the approval shares, and nothing sent when nothing is
 * left to send. A plan for less than the capture is logged, and `shortfall`
 * carries where the rest went back, for the refund's audit entry (empty when
 * the refund was the whole capture). Throws as `refundPaymentTransactions` does:
 * the webhook answers 500 and Stripe redelivers under the same keys.
 */
export async function refundLateCaptureFromOwnCharge(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
}) {
  const plan = await planAutomaticLateCaptureRefund(params);
  const [slice] = plan.allocation;
  const refunds = slice
    ? (
        await refundPaymentTransactions({
          format: params.format,
          paymentId: params.paymentId,
          amountCents: slice.amountCents,
          allocation: plan.allocation,
          metadata: buildLateCaptureRefundMetadata(params.bookingId),
          idempotencyKeyPrefix: buildLateCaptureRefundStripeKeyPrefix(params.bookingId, params.paymentIntentId),
        })
      ).refunds
    : [];
  const shortfall = {
    ...(plan.refundedElsewhereCents > 0 ? { refundedElsewhereCents: plan.refundedElsewhereCents } : {}),
    ...(plan.alreadyRefundedOnCaptureCents > 0 ? { alreadyRefundedOnCaptureCents: plan.alreadyRefundedOnCaptureCents } : {}),
  };
  if (Object.keys(shortfall).length > 0) {
    logger.warn(
      { bookingId: params.bookingId, paymentIntentId: params.paymentIntentId, allocation: plan.allocation, ...shortfall },
      "Late capture's automatic refund asked Stripe for less than the capture: the rest was already refunded (#4131)",
    );
  }
  return { refunds, shortfall };
}
