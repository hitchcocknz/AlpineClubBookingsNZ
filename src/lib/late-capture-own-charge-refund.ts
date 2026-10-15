import { PaymentRecoveryOperationType, PaymentSource } from "@prisma/client";
import { isLateCaptureHandlerWrite } from "@/lib/cancellation-settled-money";
import { READ_BACK_TIMEOUT_MS } from "@/lib/card-refund-status-sync";
import { readMigrationFinishedAt } from "@/lib/migration-finished-at";
import { providerCaptureTime } from "@/lib/stripe-capture-date";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import {
  buildCardRefundFailedLaterRecoveryKey,
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
import { getPaymentIntent, listRefundsForPaymentIntent } from "@/lib/stripe";

/**
 * #4131 (`INV-PAY-106`, `INV-PAY-110`): A LATE CAPTURE IS REFUNDED FROM ITS OWN
 * CHARGE, never another of the booking's. Every late-capture refund door pins
 * its one slice here: both webhook handlers and the treasurer's approval (the
 * repair tool pins each unheld capture's headroom by its own plan).
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

/**
 * #4131 review: the marker migration this release shipped. The previous
 * release's newest-first plan could take a slice of a late capture's refund
 * from another charge; this one cannot. It changes no schema.
 */
export const LATE_CAPTURE_OWN_CHARGE_CUTOFF_MIGRATION = "20261116010000_late_capture_own_charge_cutoff";

/**
 * How long the previous release may still serve webhooks after the marker
 * finished: a blue/green deploy migrates first and moves traffic after, and
 * the draining colour can still refund on its old plan until it stops.
 * Generous on purpose - a refund this window wrongly counts must also be on a
 * newer charge, carry this booking's late-capture metadata, be made after this
 * capture's own charge, and come from no late capture of its own.
 */
const PREVIOUS_RELEASE_OVERLAP_SECONDS = 24 * 60 * 60;

/**
 * Until when (Stripe seconds) a refund on another charge may be a slice of the
 * previous release's plan; null when no previous release ever ran here (no
 * migration history: a `prisma db push` database). Fail-safe with a history
 * whose marker has not finished (rolled back, or not run): every refund may
 * be one, as before the cutoff existed.
 */
async function previousPlanWindowEndSeconds(): Promise<number | null> {
  const marker = await readMigrationFinishedAt(prisma, LATE_CAPTURE_OWN_CHARGE_CUTOFF_MIGRATION);
  if (!marker.history) return null;
  if (marker.finishedAtSeconds === null) {
    logger.error(
      { migration: LATE_CAPTURE_OWN_CHARGE_CUTOFF_MIGRATION },
      "The late-capture own-charge cutoff migration has not finished here: every older late-capture refund on another charge is read as the previous release's (#4131)",
    );
    return Number.POSITIVE_INFINITY;
  }
  return marker.finishedAtSeconds + PREVIOUS_RELEASE_OVERLAP_SECONDS;
}

/** One slice the previous release's plan sent on another charge, as Stripe answered it. */
type PreviousPlanSlice = { refundId: string; paymentIntentId: string; amountCents: number; status: string | null };

export interface AutomaticLateCaptureRefundPlan {
  /** The one slice to send, on the capture's own charge; empty when nothing is left to send. */
  allocation: RefundAllocationSlice[];
  /**
   * DEPLOY REPLAY: what an attempt by the previous release, whose newest-first
   * plan could take slices from newer charges, already sent there - made,
   * refused or failed later alike, since its capture slice was the amount less
   * all of them. The capture's own slice is therefore that attempt's own, and
   * its own Stripe key: Stripe answers it with the refund that attempt made.
   */
  refundedElsewhereCents: number;
  /** Of those, slices Stripe refused at its answer: owed, so held for a treasurer with this refund's own answers. */
  refusedElsewhere: PreviousPlanSlice[];
  /** Of those, slices that failed later and a #4104 row already owes on their own charge. */
  owedElsewhereCents: number;
  /** What the capture no longer held: refunded on it already, so never asked for. */
  alreadyRefundedOnCaptureCents: number;
}

/**
 * The webhook's automatic refund of a late capture, planned on its own charge
 * (`lateCaptureOwnChargeSlice`).
 *
 * The automatic refund persists no plan: a crash or a 500 is replayed by
 * Stripe's redelivery, which plans again. An attempt by the previous release
 * may have sent slices on NEWER charges of the payment first (its plan was
 * newest-first; the capture's own row was never refunded, or the notice would
 * be acknowledged, `acknowledgeSettledLateNotice`). Those are read from Stripe
 * (`readPreviousPlanSlices`), so one made but never recorded counts too.
 *
 * Throws when the capture's row is missing or not captured (the handler wrote
 * it just before), or a Stripe read fails: the webhook answers 500 and Stripe
 * redelivers.
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
  const previous = await readPreviousPlanSlices({ ...params, captureId: capture.id, captureCreatedAt: capture.createdAt });
  const sentCents = Math.min(params.amountCents, previous.reduce((sum, slice) => sum + slice.amountCents, 0));
  const refused = previous.filter((slice) => isRefusedRefundStatus(slice.status));
  // #4104 already owes a slice that failed after Stripe accepted it, on its own charge.
  const failedLaterOwners = new Set(
    refused.length === 0
      ? []
      : (
          await prisma.paymentRecoveryOperation.findMany({
            where: { idempotencyKey: { in: refused.map((slice) => buildCardRefundFailedLaterRecoveryKey(slice.refundId)) } },
            select: { idempotencyKey: true },
          })
        ).map((row) => row.idempotencyKey),
  );
  const owedByFailedLater = refused.filter((slice) => failedLaterOwners.has(buildCardRefundFailedLaterRecoveryKey(slice.refundId)));
  const { slice, shortCents } = lateCaptureOwnChargeSlice(capture, params.amountCents - sentCents);
  return {
    allocation: slice.amountCents > 0 ? [slice] : [],
    refundedElsewhereCents: Math.min(sentCents, sumCents(previous.filter((each) => !isRefusedRefundStatus(each.status)))),
    refusedElsewhere: refused.filter((each) => !owedByFailedLater.includes(each)),
    owedElsewhereCents: sumCents(owedByFailedLater),
    alreadyRefundedOnCaptureCents: shortCents,
  };
}

const sumCents = (slices: ReadonlyArray<{ amountCents: number }>) => slices.reduce((sum, slice) => sum + slice.amountCents, 0);

/**
 * The slices only an attempt of THIS capture by the previous release can have
 * sent on another charge (#4131 review): a refund
 *  - on a charge of the payment NEWER than the capture's row, the only ones
 *    that newest-first plan reached before the capture's own;
 *  - whose charge is no late capture itself, by the classifier's own row test
 *    (the primary handler's write, `isLateCaptureHandlerWrite`, or a
 *    `CANCEL_PAYMENT_INTENT` recovery for it) or a task that owns it - a
 *    sibling's own refund carries the same metadata;
 *  - carrying this booking's late-capture metadata (`buildLateCaptureRefundMetadata`);
 *  - made at or after this capture's charge, and before the previous release
 *    stopped (`previousPlanWindowEndSeconds`) - so an earlier capture's old
 *    slice, or anything this release made, is never counted.
 * Any status: refused and failed slices were part of that plan's sum too.
 */
async function readPreviousPlanSlices(params: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  captureId: string;
  captureCreatedAt: Date;
}): Promise<PreviousPlanSlice[]> {
  const newer = (
    await prisma.paymentTransaction.findMany({
      where: {
        paymentId: params.paymentId,
        source: PaymentSource.STRIPE,
        id: { not: params.captureId },
        createdAt: { gt: params.captureCreatedAt },
        stripePaymentIntentId: { not: null },
      },
      select: { stripePaymentIntentId: true, status: true, reason: true },
    })
  ).filter((row) => isCapturedTransactionStatus(row.status) && !isLateCaptureHandlerWrite(row.reason));
  let intents = newer.map((row) => row.stripePaymentIntentId as string);
  if (intents.length === 0) return [];
  const windowEnd = await previousPlanWindowEndSeconds();
  if (windowEnd === null) return [];
  const [owned, cancelMarked] = await Promise.all([
    findLateCapturePaymentIntents(intents),
    prisma.paymentRecoveryOperation.findMany({
      where: { type: PaymentRecoveryOperationType.CANCEL_PAYMENT_INTENT, paymentIntentId: { in: intents } },
      select: { paymentIntentId: true },
    }),
  ]);
  const cancelMarkedIntents = new Set(cancelMarked.map((row) => row.paymentIntentId));
  intents = intents.filter((intent) => !owned.has(intent) && !cancelMarkedIntents.has(intent));
  if (intents.length === 0) return [];
  // Bounded reads, no retries (`READ_BACK_TIMEOUT_MS`): a hang is a quick 500, and the redelivery plans again.
  const chargedAtSeconds = Math.floor(
    providerCaptureTime(
      await getPaymentIntent(params.paymentIntentId, { timeoutMs: READ_BACK_TIMEOUT_MS, expand: ["latest_charge"] }),
    ).getTime() / 1000,
  );
  if (chargedAtSeconds >= windowEnd) return [];
  const slices: PreviousPlanSlice[] = [];
  for (const intent of intents) {
    for (const refund of await listRefundsForPaymentIntent(intent, { timeoutMs: READ_BACK_TIMEOUT_MS })) {
      if (
        refund.metadata?.reason === LATE_CAPTURE_REFUND_METADATA_REASON &&
        refund.metadata?.bookingId === params.bookingId &&
        refund.created >= chargedAtSeconds &&
        refund.created < windowEnd
      ) {
        slices.push({ refundId: refund.id, paymentIntentId: intent, amountCents: refund.amount, status: refund.status ?? null });
      }
    }
  }
  return slices;
}

/**
 * The primary webhook handler's automatic refund of a late capture: planned on
 * its own charge (`planAutomaticLateCaptureRefund`), sent under the late-capture
 * Stripe key and body the approval shares, and nothing sent when nothing is
 * left to send.
 *
 * `answers` are what the hold reads (`holdLateCaptureRefusedByStripe`): this
 * refund's own, and a slice the previous release's plan sent elsewhere that
 * Stripe refused, which is owed. `audit` reconciles the refund's audit entry:
 * `amountCents` (the whole capture) = `refundedNowCents` +
 * `refundedElsewhereCents` + `owedElsewhereCents` +
 * `alreadyRefundedOnCaptureCents`, the last three only when non-zero, and
 * `noRefundSentReason` when nothing was sent now. A refund for less than the
 * capture is logged. Throws as `refundPaymentTransactions` does: the webhook
 * answers 500 and Stripe redelivers under the same keys.
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
    ...(plan.owedElsewhereCents > 0 ? { owedElsewhereCents: plan.owedElsewhereCents } : {}),
    ...(plan.alreadyRefundedOnCaptureCents > 0 ? { alreadyRefundedOnCaptureCents: plan.alreadyRefundedOnCaptureCents } : {}),
  };
  if (Object.keys(shortfall).length > 0) {
    logger.warn(
      { bookingId: params.bookingId, paymentIntentId: params.paymentIntentId, allocation: plan.allocation, ...shortfall },
      "Late capture's automatic refund asked Stripe for less than the capture: the rest was already refunded (#4131)",
    );
  }
  const refusedElsewhere = plan.refusedElsewhere.map((each) => ({ ...each, status: each.status ?? "failed" }));
  return {
    refunds,
    answers: [...refusedElsewhere, ...refunds],
    audit: {
      refundedNowCents: sumCents(refunds.filter((refund) => !isRefusedRefundStatus(refund.status))),
      ...shortfall,
      ...(slice ? {} : { noRefundSentReason: "Nothing was left to send: the capture's refund was already made, on its own charge or by an earlier attempt on another." }),
    },
  };
}
