/**
 * A manual mark-paid's Stripe-intent hygiene and its reversal's undoing of it,
 * in one home (#2262, #4320, `INV-PAY-045`): the settle queues a
 * CANCEL_PAYMENT_INTENT for every live card intent and records which of those
 * another writer had already queued; the reversal re-applies the supersede
 * rule to the restored booking and withdraws the cancellation of every intent
 * that booking can still be paid with.
 *
 * Both run inside the caller's transaction, under its locks (global lock(1),
 * the lodge key and the Payment row); neither calls a provider.
 */
import { PaymentSource, PaymentStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import {
  queueSupersededAdditionalIntentCancellationRows,
  queueSupersededPrimaryIntentCancellations,
} from "@/lib/booking-payment-cleanup";
import { enqueuePaymentIntentCancellationRecovery } from "@/lib/payment-recovery";
import { buildPaymentIntentCancelRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import { liveSupersededOperation } from "@/lib/superseded-intent-ownership";

/**
 * B5 (#2262) Stripe-intent hygiene for a manual settlement. Any Stripe intent
 * on this payment that has NOT reached a terminal state is still capable of
 * capturing — the member's `/pay` tab may hold a live client secret — so a
 * durable CANCEL_PAYMENT_INTENT recovery operation is enqueued for each,
 * ATOMICALLY with the settlement and BEFORE any Stripe call. The best-effort
 * Stripe cancel itself runs after commit, never inside this transaction.
 *
 * Returns the intent ids so the caller can attempt the cancel, and so the
 * reversal can name exactly what it disarmed.
 *
 * #2397 F4 — `spareAdditionalPaymentIntentId`. The blanket cancel was right
 * while a manual settlement ALWAYS recorded the whole amount owing: every live
 * intent, primary or additional, was then a door to a second payment for money
 * the club already held. The "the cash did not cover the extra" answer breaks
 * that assumption for exactly one intent — the addition's own — because that
 * extra is deliberately still owed, and this intent is the ONLY self-service
 * instrument for it (`/api/bookings/[id]/additional-payment-secret` hands back
 * precisely `Payment.additionalPaymentIntentId`, and the member's booking page
 * renders the pay card off `additionalAmountCents` + a non-SUCCEEDED
 * `additionalPaymentStatus`; neither gates on booking status, so both keep
 * working on the now-PAID booking).
 *
 * Cancelling it left the club chasing money the member had no way to send —
 * the worst available outcome. Sparing it is also ledger-correct: capturing it
 * routes through `markPaymentIntentTransactionSucceeded` ->
 * `reconcilePaymentAggregates`, which sums the captured rows, so
 * `Payment.amountCents` becomes cash + addition = `finalPriceCents` and the
 * generalised mirror closes with a zero third term.
 *
 * ONE intent is spared, by id, never "all ADDITIONAL rows": a superseded
 * addition intent is a stale door to a figure nobody is owed any more, and
 * `additionalPaymentIntentId` is the single pointer every consumer honours.
 *
 * #4320 — `adoptedIntentIds`: the intents whose cancellation another writer
 * had ALREADY queued (an edit that superseded the intent, say). The enqueue
 * upserts on the shared cancel key and never touches an existing row's status,
 * so the settle adopts that row rather than minting one. A reversal keeps an
 * adopted row even when the restored price matches its intent again: a
 * superseded intent is never handed out again (`INV-PAY-138`), and a reason the
 * ledger cannot show (an intent in a currency the club no longer charges in,
 * #3567) is still its writer's. The audit row records the list
 * (`manualSettleIntentHygieneAuditFields`).
 */
export async function enqueueManualSettlementIntentCancellations(
  tx: Prisma.TransactionClient,
  {
    bookingId,
    paymentId,
    spareAdditionalPaymentIntentId = null,
  }: {
    bookingId: string;
    paymentId: string;
    spareAdditionalPaymentIntentId?: string | null;
  }
): Promise<{ cancelledIntentIds: string[]; adoptedIntentIds: string[]; sparedIntentId: string | null }> {
  const liveTransactions = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      source: PaymentSource.STRIPE,
      stripePaymentIntentId: { not: null },
      // Non-terminal only. A SUCCEEDED row is money already in the ledger (and
      // the duplicate-capture machinery's business), and FAILED/REFUNDED rows
      // have nothing left to cancel.
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
    },
    select: {
      id: true,
      kind: true,
      stripePaymentIntentId: true,
      amountCents: true,
    },
  });

  let sparedIntentId: string | null = null;
  const toCancel: Array<{ id: string; stripePaymentIntentId: string; amountCents: number }> = [];
  for (const transaction of liveTransactions) {
    if (!transaction.stripePaymentIntentId) continue;
    // Both halves are required: the id must be the payment's CURRENT addition
    // pointer AND the row must actually be an ADDITIONAL one, so a mismatched
    // pointer can never spare a live primary intent.
    if (
      spareAdditionalPaymentIntentId !== null &&
      transaction.kind === PaymentTransactionKind.ADDITIONAL &&
      transaction.stripePaymentIntentId === spareAdditionalPaymentIntentId
    ) {
      sparedIntentId = transaction.stripePaymentIntentId;
      continue;
    }
    toCancel.push({ ...transaction, stripePaymentIntentId: transaction.stripePaymentIntentId });
  }

  // #4320: which cancellations were queued before this settle, read before its
  // upserts. Not every writer of these rows holds lock(1) (the `/pay` link's
  // supersede does not), so one landing between this read and the upsert reads
  // as minted here. A reversal then re-derives it: a stale amount is cancelled
  // again; only a wrong-currency supersede at the owed amount is lost, as it
  // was before #4320.
  const keys = toCancel.map((transaction) =>
    buildPaymentIntentCancelRecoveryIdempotencyKey(transaction.id, transaction.stripePaymentIntentId)
  );
  const alreadyQueued =
    keys.length === 0
      ? []
      : await tx.paymentRecoveryOperation.findMany({
          where: { idempotencyKey: { in: keys } },
          select: { paymentIntentId: true },
        });
  const adoptedIntentIds = [...new Set(alreadyQueued.map((operation) => operation.paymentIntentId))];

  const cancelledIntentIds: string[] = [];
  for (const transaction of toCancel) {
    await enqueuePaymentIntentCancellationRecovery({
      bookingId,
      paymentId,
      paymentTransactionId: transaction.id,
      paymentIntentId: transaction.stripePaymentIntentId,
      amountCents: transaction.amountCents,
      store: tx,
    });
    cancelledIntentIds.push(transaction.stripePaymentIntentId);
  }
  return { cancelledIntentIds, adoptedIntentIds, sparedIntentId };
}

/** The settle's audit-metadata key for `adoptedIntentIds`, written and read only here (`INV-SSOT`). */
const ADOPTED_CANCEL_INTENTS_KEY = "adoptedCancelPaymentIntentIds";

/**
 * The intent-hygiene fields of the mark-paid's audit row (#4320): every intent
 * it queued a cancellation for, and those of them another writer had already
 * queued. The reversal reads the second back (`readAdoptedCancelIntentIds`), so
 * both must be exactly what THIS settle found (empty when nothing).
 */
export function manualSettleIntentHygieneAuditFields({
  cancelledIntentIds,
  adoptedIntentIds,
}: {
  cancelledIntentIds: string[];
  adoptedIntentIds: string[];
}) {
  return { cancelledPaymentIntentIds: cancelledIntentIds, [ADOPTED_CANCEL_INTENTS_KEY]: adoptedIntentIds };
}

/**
 * The adopted list off the matching mark-paid's audit row. Every gap - no
 * settle row, or one written before #4320 - reads as adopting nothing, which
 * only ever withdraws more: the re-derived supersede rule still cancels every
 * stale intent.
 */
function readAdoptedCancelIntentIds(metadata: Prisma.JsonValue | null | undefined): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = (metadata as Prisma.JsonObject)[ADOPTED_CANCEL_INTENTS_KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The reversal's disarm (#2262 HIGH #1, #4320, `INV-PAY-045`), inside the
 * reversal's transaction, after it has restored the booking: re-apply the
 * supersede rule to the restored booking, then delete the live
 * superseded-intent rows of every intent that booking can still be paid with.
 * Returns the rows it deleted, as it read them, for the audit trail, and the
 * intents still being cancelled.
 *
 * DERIVED, NOT REMEMBERED. Which cancellations the settle "owned" cannot be
 * read off the rows: the cancel key is shared, so an edit on the PAID booking,
 * an additional ask's supersede or the `/pay` link's supersede can upsert the
 * very row the settle minted, and a settle recorded before #4320 kept no list.
 * What the restored booking needs is derivable, by the rules every other writer
 * already applies:
 *
 * - a PRIMARY intent is stale unless its amount is what the booking owes
 *   (`readBookingAmountOwed`, the figure the pay step mints at), the #1161
 *   rule (`queueSupersededPrimaryIntentCancellations`);
 * - an ADDITIONAL intent is stale unless it is the payment's live ask
 *   (`additionalPaymentIntentId`, the one pointer every consumer honours), the
 *   #3340 rule (`queueSupersededAdditionalIntentCancellationRows`).
 *
 * Both rules run here first, so a stale intent keeps or regains a live
 * cancellation (a fresh PENDING row where it had none; an existing row keeps
 * its status). Then every live row is withdrawn whose intent is a live card
 * intent on the payment that neither rule condemned and the settle did not
 * adopt (`readAdoptedCancelIntentIds`). A row on an intent the ledger already
 * retired (FAILED, withdrawn) is never withdrawn: no restored state makes that
 * intent payable, and its row is the only thing still cancelling it at Stripe.
 */
export async function withdrawManualSettlementIntentCancellations(
  tx: Prisma.TransactionClient,
  {
    booking,
    paymentId,
    liveAdditionalPaymentIntentId,
    settleAuditMetadata,
  }: {
    booking: { id: string; finalPriceCents: number; payment: { changeFeeCents: number | null } | null };
    paymentId: string;
    liveAdditionalPaymentIntentId: string | null;
    settleAuditMetadata: Prisma.JsonValue | null | undefined;
  }
) {
  const { owedCents } = await readBookingAmountOwed(booking, tx);
  const stalePrimary = await queueSupersededPrimaryIntentCancellations(tx, {
    bookingId: booking.id,
    paymentId,
    newFinalPriceCents: owedCents,
  });
  const staleAdditional = await queueSupersededAdditionalIntentCancellationRows({
    bookingId: booking.id,
    paymentId,
    newPaymentIntentId: liveAdditionalPaymentIntentId,
    store: tx,
  });
  const stillCancelledIntentIds = [
    ...new Set([...stalePrimary, ...staleAdditional].map((superseded) => superseded.paymentIntentId)),
  ];
  const kept = [...stillCancelledIntentIds, ...readAdoptedCancelIntentIds(settleAuditMetadata)];

  // The intents the restored booking can be paid with: live card intents on
  // the payment that no rule above condemned.
  const payable = await tx.paymentTransaction.findMany({
    where: {
      paymentId,
      source: PaymentSource.STRIPE,
      status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
      stripePaymentIntentId: { not: null, notIn: kept },
    },
    select: { stripePaymentIntentId: true },
  });
  const payableIntentIds = payable.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));

  // DELETED, not flipped to a terminal status: every webhook-side liveness
  // predicate keys on `status != SUCCEEDED` (queueSupersededPaymentIntentRefundRecovery,
  // listLiveSupersededIntentIds, findLiveSupersededIntentOperation), so a
  // FAILED "closed" row would still read as LIVE to all of them - a
  // post-reversal capture would be handed to the superseded refund (member
  // charged, refunded, booking never settles). Deletion makes every predicate
  // coherent at once, and re-arms a later re-mark cleanly: its upsert finds no
  // row and mints a fresh PENDING one. Every status those predicates read as
  // live is withdrawn (`liveSupersededOperation`): PENDING, PROCESSING and
  // FAILED, retrying or exhausted. A FAILED row is not finished - the worker
  // retries it and the webhook hands a capture to it either way.
  //
  // A REFUND_SUPERSEDED_PAYMENT row is not reached in practice: the hand-off
  // that creates one marks its transaction SUCCEEDED in the same transaction
  // as its claim, under the Payment row this reversal holds, and the reversal
  // refuses on any settled Stripe transaction before it calls this.
  //
  // The rows' full content is read first and preserved in the AuditLog
  // metadata, so the audit trail - not the queue - is where they live on.
  const liveOperations =
    payableIntentIds.length === 0
      ? []
      : await tx.paymentRecoveryOperation.findMany({
          where: { paymentId, paymentIntentId: { in: payableIntentIds }, ...liveSupersededOperation() },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            type: true,
            status: true,
            paymentIntentId: true,
            paymentTransactionId: true,
            amountCents: true,
            idempotencyKey: true,
            attempts: true,
            createdAt: true,
          },
        });
  // Status-fenced WRITE, one row at a time, idempotent by construction: a
  // replayed reversal deletes zero rows (and its own fenced payment write
  // 409s). The fence is the liveness predicate itself, so a worker's claim
  // racing this (FAILED -> PROCESSING) is deleted all the same, while a row a
  // worker finished meanwhile (SUCCEEDED) is left and not reported closed.
  // A worker that claimed a row before this delete commits re-claims under
  // the Payment row before it records a capture, so its hand-off matches
  // nothing once the row is gone. Its Stripe cancel call is outside that
  // lock and may still reach Stripe after this commits: the member's open
  // tab then fails, and the pay step mints a fresh intent. No money moves.
  const withdrawn: typeof liveOperations = [];
  for (const operation of liveOperations) {
    const deleted = await tx.paymentRecoveryOperation.deleteMany({
      where: { id: operation.id, ...liveSupersededOperation() },
    });
    if (deleted.count === 1) withdrawn.push(operation);
  }
  return { withdrawn, stillCancelledIntentIds };
}
