/**
 * #4359 (#4361 wave 1, design D; `INV-PAY-140`): THE RECOVERY RUNNER READS
 * STRIPE BEFORE IT SENDS A CARD REFUND, AND SENDS NOTHING WHEN A REFUND MADE
 * OUTSIDE THE APP MAY ALREADY HAVE PAID IT.
 *
 * A treasurer can refund a card in the Stripe dashboard while the app still
 * owes that card a refund - a refund Stripe failed later (#4104) or refused
 * (#4083), or any row still waiting its turn. The runner sends its own slices
 * whatever else Stripe holds, so the member was paid twice and nothing said so.
 *
 * So, after the runner's claim and before any Stripe refund call, outside any
 * transaction (`checkStripeBeforeCardRefundSend`):
 *
 * - **One bounded read per intent** the slices to send are on
 *   (`listRefundsForPaymentIntent`, `READ_BACK_TIMEOUT_MS`, no retries, each
 *   refund's failure expanded). A read
 *   that fails sends nothing and fails the attempt, which the backoff retries:
 *   it only delays the refund.
 * - **Every refund the app has not seen is recorded** through what
 *   `charge.refunded` does (`recordChargeRefunds`): the one ledger writer, and
 *   the Xero notes for what it newly recorded, so the webhook that follows
 *   finds nothing new and no note is lost. Only refunds with no ledger row:
 *   bringing a known refund's status up to date is the webhook's and the cron
 *   read-back's (`card-refund-status-sync.ts`), and here could meet this very
 *   row held (`FailedLaterRefundHeldError`).
 * - **The hold** (`dashboardRefundsHoldingSend`): a refund Stripe counts on a
 *   slice's intent that carries no app metadata (`cardRefundDoorOf`:
 *   `outside-app`, made in the Stripe dashboard), made at or after the slice's
 *   debt arose (`cardRefundDebtAroseAtSeconds`) - an exact before/after on
 *   Stripe's own clock, in its whole seconds, not a window. Any amount: whether
 *   it paid this debt is a person's question (stage 3 of #4361 asks it). Then
 *   the whole row sends nothing: `CardRefundResendHeldError`, which the
 *   runner's one failure path ends at once (`failPaymentRecoveryOperation`):
 *   attempts spent, compare-and-set on its own claim, `lastError` coded
 *   (`CARD_REFUND_RESEND_HELD_CODE`), the officers alerted and the hold audited.
 *
 * STATED LIMIT: a dashboard refund Stripe makes after this read and before the
 * send is not seen (#4361's sub-second race; stage 3 closes it).
 */
import type Stripe from "stripe";

import { createAuditLog } from "@/lib/audit";
import { CLOSE_IT_WHERE } from "@/lib/card-refund-failed-later";
import { cardRefundDoorOf } from "@/lib/card-refund-own-note-share";
import { READ_BACK_TIMEOUT_MS } from "@/lib/card-refund-status-sync";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { cardRefundSliceFailedRefundIds, carriesCardRefundOperationMetadata } from "@/lib/open-card-refund-owed";
import { CARD_REFUND_RESEND_HELD_CODE } from "@/lib/payment-recovery-constants";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";
import { formatCents } from "@/lib/utils";

/** A refund Stripe lists on an intent, as this check reads it. */
export type StripeRefundOnIntent = Pick<Stripe.Refund, "id" | "amount" | "status" | "created" | "metadata"> & {
  failure_balance_transaction?: Stripe.Refund["failure_balance_transaction"];
};

/** The read's expansion: when Stripe failed a refund, on its own clock (`failedAtSeconds`). */
export const CARD_REFUND_READ_EXPAND = ["data.failure_balance_transaction"];

/**
 * When Stripe failed a refund: its failure's balance transaction, read expanded
 * (`CARD_REFUND_READ_EXPAND`); where Stripe gives none, when Stripe made it,
 * which is never later - so a debt is never read as arising after it did.
 */
export function failedAtSeconds(refund: StripeRefundOnIntent): number {
  const failure = refund.failure_balance_transaction;
  return failure && typeof failure === "object" && typeof failure.created === "number" ? failure.created : refund.created;
}

/** The row being sent, as the check reads it: its raise time and the metadata its runner sends. */
export type CardRefundSendOperation = {
  id: string;
  type: string;
  idempotencyKey: string;
  stripeKeyPrefix: string | null;
  bookingId: string;
  paymentId: string;
  createdAt: Date;
};

/** A slice about to be sent, with the refunds Stripe holds on its intent. */
export type CardRefundSendSlice = { slice: RefundAllocationSlice; onIntent: ReadonlyArray<StripeRefundOnIntent> };

/** One refund made outside the app that holds a slice's send. */
export type CardRefundSendHold = { slice: RefundAllocationSlice; refund: StripeRefundOnIntent; debtAroseAtSeconds: number };

const toSeconds = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * WHEN THE DEBT A SLICE IS SENT FOR AROSE, on Stripe's clock in whole seconds:
 *
 * - a slice sent for refunds Stripe failed later (`cardRefundSliceFailedRefundIds`):
 *   when Stripe failed the earliest of them (`failedAtSeconds`) - a refund
 *   made while it was still pending is not this debt's answer;
 * - a slice Stripe refused (`stripeKeySuffix`): when Stripe refused the
 *   earliest refusal on its intent of its amount that this row's runner could
 *   have sent (`carriesCardRefundOperationMetadata`);
 * - otherwise, or with no such refund listed: when the row was raised.
 */
export function cardRefundDebtAroseAtSeconds(
  operation: CardRefundSendOperation,
  { slice, onIntent }: CardRefundSendSlice,
): number {
  const failed = cardRefundSliceFailedRefundIds(operation, slice);
  const debtRefunds =
    failed.length > 0
      ? onIntent.filter((refund) => failed.includes(refund.id))
      : slice.stripeKeySuffix
        ? onIntent.filter(
            (refund) =>
              isRefusedRefundStatus(refund.status) &&
              refund.amount === slice.amountCents &&
              carriesCardRefundOperationMetadata(operation, refund.metadata),
          )
        : [];
  return debtRefunds.length > 0 ? Math.min(...debtRefunds.map(failedAtSeconds)) : toSeconds(operation.createdAt);
}

/**
 * THE HOLD, pure: each refund Stripe counts on a slice's intent (not failed or
 * cancelled) that carries no app metadata (`cardRefundDoorOf`: `outside-app`)
 * and that Stripe made at or after the slice's debt arose. One before it is
 * never this debt's answer; one at or after it may be.
 */
export function dashboardRefundsHoldingSend(
  operation: CardRefundSendOperation,
  slices: ReadonlyArray<CardRefundSendSlice>,
): CardRefundSendHold[] {
  return slices.flatMap((send) => {
    const debtAroseAtSeconds = cardRefundDebtAroseAtSeconds(operation, send);
    return send.onIntent
      .filter(
        (refund) =>
          !isRefusedRefundStatus(refund.status) &&
          cardRefundDoorOf(refund.metadata) === "outside-app" &&
          refund.created >= debtAroseAtSeconds,
      )
      .map((refund) => ({ slice: send.slice, refund, debtAroseAtSeconds }));
  });
}

/**
 * The row's hold, thrown before any Stripe refund call. The runner's failure
 * path ends the row on it at once (`failPaymentRecoveryOperation`): `lastError`
 * is `message`, the officers' alert says `alertMessage` for `heldCents`, and
 * the hold is audited (`auditCardRefundResendHeld`).
 */
export class CardRefundResendHeldError extends Error {
  readonly alertMessage: string;
  /** The audit row's summary, its amount formatted as the club reads it. */
  readonly auditSummary: string;
  constructor(
    readonly heldCents: number,
    readonly holds: ReadonlyArray<CardRefundSendHold>,
    readonly paymentIntentIds: ReadonlyArray<string>,
    format: ClubFormat,
  ) {
    const refunds = [...new Map(holds.map((hold) => [hold.refund.id, hold.refund])).values()];
    const ids = refunds.map((refund) => refund.id).join(", ");
    super(
      `${CARD_REFUND_RESEND_HELD_CODE}: Stripe holds a refund made outside the app (${ids}) on this card payment since this refund became owed, so the app did not send it again. Check the payment in the Stripe dashboard before using "Paid another way" (#4359).`,
    );
    this.name = "CardRefundResendHeldError";
    const owed = formatCents(heldCents, format);
    const madeOutside = formatCents(refunds.reduce((sum, refund) => sum + refund.amount, 0), format);
    this.auditSummary = `A card refund of ${owed} was not sent again: Stripe holds a refund made outside the app on that payment since it became owed`;
    this.alertMessage = `Stripe holds a card refund of ${madeOutside} made outside the app, in the Stripe dashboard (${ids}), on this payment since this card refund of ${owed} became owed. The app has not sent ${owed} again, so the member is not paid twice. Check the payment in the Stripe dashboard: if that refund paid this back, nothing more is owed, so do not pay the member again. If it did not, pay the member with "Paid another way" and ${CLOSE_IT_WHERE}, not with another Stripe dashboard refund.`;
  }
}

/** The audit row of a hold, written once the hold's own write landed. Never throws: the row is already held. */
export async function auditCardRefundResendHeld(
  operation: Pick<CardRefundSendOperation, "id" | "bookingId" | "paymentId">,
  held: CardRefundResendHeldError,
): Promise<void> {
  await createAuditLog({
    action: "booking-payment.card-refund.resend-held",
    targetId: operation.bookingId,
    entityType: "PaymentRecoveryOperation",
    entityId: operation.id,
    category: "payment",
    severity: "important",
    outcome: "failure",
    summary: held.auditSummary,
    metadata: {
      paymentId: operation.paymentId,
      heldCents: held.heldCents,
      paymentIntentIds: held.paymentIntentIds,
      refunds: held.holds.map((hold) => ({
        stripeRefundId: hold.refund.id,
        amountCents: hold.refund.amount,
        stripeCreatedAt: hold.refund.created,
        debtAroseAtSeconds: hold.debtAroseAtSeconds,
        paymentTransactionId: hold.slice.paymentTransactionId,
      })),
    },
  }).catch((err: unknown) => logger.error({ err, operationId: operation.id }, "Could not audit a held card refund (#4359)"));
}

/** Every refund on these intents the ledger has no row for, recorded as `charge.refunded` records them. */
async function recordUnseenRefunds(byIntent: ReadonlyMap<string, Stripe.Refund[]>): Promise<void> {
  const listed = [...byIntent.values()].flat();
  if (listed.length === 0) return;
  const known = await prisma.paymentRefund.findMany({
    where: { stripeRefundId: { in: listed.map((refund) => refund.id) } },
    select: { stripeRefundId: true },
  });
  const seen = new Set(known.map((row) => row.stripeRefundId));
  if (listed.every((refund) => seen.has(refund.id))) return;
  // Dynamic: the webhook's service imports the recovery module this check is called from.
  const { recordChargeRefunds } = await import("@/lib/stripe-webhook-service");
  for (const [paymentIntentId, refunds] of byIntent) {
    const charges = new Set(refunds.map((refund) => stripeReferenceId(refund.charge)));
    for (const chargeId of charges) {
      const onCharge = refunds.filter((refund) => stripeReferenceId(refund.charge) === chargeId);
      const record = onCharge.filter((refund) => !seen.has(refund.id));
      if (record.length === 0) continue;
      if (!chargeId) {
        logger.warn({ paymentIntentId, refundIds: record.map((refund) => refund.id) }, "A refund Stripe lists names no charge; not recorded before a card refund send (#4359)");
        continue;
      }
      const amountRefundedCents = onCharge.reduce((sum, refund) => sum + (isRefusedRefundStatus(refund.status) ? 0 : refund.amount), 0);
      await recordChargeRefunds({ paymentIntentId, chargeId, amountRefundedCents, refunds: onCharge, record });
    }
  }
}

/**
 * THE CHECK, before the runner's card refund call: read, record, decide (see
 * the module comment). Throws `CardRefundResendHeldError` to hold the row, or
 * any other error - a failed read, a failed record - to fail the attempt for
 * the backoff; either way nothing was sent. Returns when the slices may go.
 * Never inside a transaction.
 */
export async function checkStripeBeforeCardRefundSend({
  operation,
  plan,
  format,
}: {
  operation: CardRefundSendOperation;
  /** The plan the runner sends from: a slice marked made (`madeRefundId`) is never sent, and not read for. */
  plan: ReadonlyArray<RefundAllocationSlice>;
  format: ClubFormat;
}): Promise<void> {
  const toSend = plan.filter((slice) => !slice.madeRefundId);
  if (toSend.length === 0) return;
  const transactions = await prisma.paymentTransaction.findMany({
    where: { id: { in: [...new Set(toSend.map((slice) => slice.paymentTransactionId))] } },
    select: { id: true, stripePaymentIntentId: true },
  });
  const intentOf = new Map(transactions.map((transaction) => [transaction.id, transaction.stripePaymentIntentId]));
  const byIntent = new Map<string, Stripe.Refund[]>();
  for (const paymentIntentId of new Set(toSend.map((slice) => intentOf.get(slice.paymentTransactionId)))) {
    if (!paymentIntentId) continue;
    try {
      byIntent.set(paymentIntentId, await listRefundsForPaymentIntent(paymentIntentId, { timeoutMs: READ_BACK_TIMEOUT_MS, expand: CARD_REFUND_READ_EXPAND }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read the refunds Stripe holds on ${paymentIntentId} before sending this card refund, so nothing was sent; it is retried (#4359): ${reason}`);
    }
  }
  await recordUnseenRefunds(byIntent);
  const holds = dashboardRefundsHoldingSend(
    operation,
    toSend.map((slice) => ({ slice, onIntent: byIntent.get(intentOf.get(slice.paymentTransactionId) ?? "") ?? [] })),
  );
  if (holds.length === 0) return;
  const heldCents = toSend.reduce((sum, slice) => sum + slice.amountCents, 0);
  throw new CardRefundResendHeldError(heldCents, holds, [...byIntent.keys()], format);
}
