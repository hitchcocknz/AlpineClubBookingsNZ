/**
 * A manual mark-paid's Stripe-intent hygiene and its reversal's undoing of it,
 * in one home (#2262, #4320, `INV-PAY-045`): the settle queues a
 * CANCEL_PAYMENT_INTENT for every live card intent and records which of those
 * another writer had already queued; the reversal withdraws the rest.
 *
 * Both run inside the caller's transaction, under its locks (global lock(1),
 * the lodge key and the Payment row); neither calls a provider.
 */
import { PaymentSource, PaymentStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";
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
 * so the settle adopts that row rather than minting one. A reversal undoes only
 * what the settle did: it withdraws the rows the settle minted and leaves an
 * adopted row to finish the job its own writer queued it for
 * (`reverseManualBookingPayment`, `INV-PAY-045`).
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
  // as minted here - the reading every row had before #4320, withdrawn by a
  // reversal.
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

/**
 * #4320 — the intents whose cancellation the matching mark-paid itself minted,
 * read back off its audit row, so the REVERSAL withdraws those rows and no
 * others (`INV-PAY-045`): `cancelledPaymentIntentIds` less
 * `adoptedCancelPaymentIntentIds`.
 *
 * Defensive for the same reason as the readers above, and each gap reads as
 * the rule before it: no cancelled list (no settle row found, or one that
 * never recorded it) returns null, which the reversal reads as every live row
 * on the payment; no adopted list, as on every row written before #4320,
 * adopts nothing.
 */
function settleWithdrawableIntentIds(
  metadata: Prisma.JsonValue | null | undefined
): string[] | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const object = metadata as Prisma.JsonObject;
  const strings = (value: Prisma.JsonValue | undefined) =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as string[])
      : null;
  const cancelled = strings(object.cancelledPaymentIntentIds);
  if (cancelled === null) return null;
  const adopted = new Set(strings(object.adoptedCancelPaymentIntentIds) ?? []);
  return cancelled.filter((intentId) => !adopted.has(intentId));
}

/**
 * The reversal's disarm (#2262 HIGH #1, #4320): delete the settle's own
 * superseded-intent rows still live, inside the reversal's transaction, and
 * return the rows it deleted, as it read them, for the audit trail.
 * `settleAuditMetadata` is the matching mark-paid's audit row.
 */
export async function withdrawManualSettlementIntentCancellations(
  tx: Prisma.TransactionClient,
  { paymentId, settleAuditMetadata }: { paymentId: string; settleAuditMetadata: Prisma.JsonValue | null | undefined }
) {
  // HIGH #1 — disarm, inside this transaction, before anything else is
  // written. The disarmed operations are DELETED, not flipped to a terminal
  // status: every webhook-side liveness predicate keys on
  // `status != SUCCEEDED` (queueSupersededPaymentIntentRefundRecovery,
  // listLiveSupersededIntentIds, findLiveSupersededIntentOperation), so a
  // FAILED "closed" row would still read as LIVE to all of them — a
  // post-reversal capture from a stale /pay tab would be handed to the
  // superseded-refund machinery (member charged, silently refunded, booking
  // never settles) and the intent id would sit in the duplicate-guard's
  // `notIn` exclusion forever. Deletion makes every one of those predicates
  // coherent at once, and it re-arms a later re-mark cleanly: the settle's
  // enqueue upsert finds no row and its CREATE arm fires with a fresh
  // PENDING status and nextRetryAt.
  //
  // #4320 — scope, by status: every row those predicates read as live
  // (`liveSupersededOperation`), so PENDING, PROCESSING and FAILED, retrying
  // or exhausted. A FAILED row is not finished: the worker retries it and the
  // webhook hands a capture to it either way, so one left behind by a Stripe
  // outage refunded the member's capture of an intent this reversal made
  // payable again. An exhausted row is moot once the settle it protected is
  // gone; its alert and content live on in the audit trail.
  //
  // #4320 — scope, by intent: only the intents the settle itself condemned,
  // read back off its audit row - `cancelledPaymentIntentIds` less
  // `adoptedCancelPaymentIntentIds`, the ones whose cancellation another
  // writer (an edit that superseded the intent, say) had queued first. The
  // reversal puts back the state before the settle, and in that state those
  // intents were already being cancelled: their rows stay and do their
  // writer's job. A settle row without the cancelled list (none found)
  // reads as the pre-#4320 scope, every such row on the payment; one without
  // the adopted list, written before #4320, as adopting nothing.
  //
  // A member-owed REFUND_SUPERSEDED_PAYMENT op can never be reached here,
  // because the handoff that creates one marks its transaction SUCCEEDED
  // first and the reversal refuses on any settled Stripe transaction before
  // it calls this.
  //
  // The rows' full content is read first and preserved in the AuditLog
  // metadata and the reversal's BookingEvent snapshot (ids), so the audit
  // trail — not the queue — is where the closed operations live on.
  const withdrawnIntentIds = settleWithdrawableIntentIds(settleAuditMetadata);
  const liveOperations = await tx.paymentRecoveryOperation.findMany({
    where: {
      paymentId,
      ...liveSupersededOperation(),
      ...(withdrawnIntentIds === null ? {} : { paymentIntentId: { in: withdrawnIntentIds } }),
    },
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
  // worker finished meanwhile (SUCCEEDED) is left and not reported closed. A
  // worker that already claimed one of these PROCESSING can no longer
  // complete or hand it off — its re-claim and its fenced completion both
  // match nothing once the row is gone (see
  // handoffSucceededSupersededIntentToRefund / completePaymentRecoveryOperation
  // in payment-recovery.ts).
  const doomedOperations: typeof liveOperations = [];
  for (const operation of liveOperations) {
    const deleted = await tx.paymentRecoveryOperation.deleteMany({
      where: { id: operation.id, ...liveSupersededOperation() },
    });
    if (deleted.count === 1) doomedOperations.push(operation);
  }
  return doomedOperations;
}
