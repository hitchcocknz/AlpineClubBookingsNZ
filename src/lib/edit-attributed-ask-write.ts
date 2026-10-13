/**
 * #4036 review: AN EDIT'S ASK ROW IS NEVER WRITTEN OVER ANOTHER EDIT'S.
 *
 * `upsertPaymentIntentTransaction` routes here every write that names its
 * `bookingModificationId` - the door's ordinary and re-issue writes, the
 * recovery runner's, and the currency re-issue's - so one Stripe intent is
 * never recorded as two edits' asks, whatever handed the writer that intent: a
 * runner's adoption by what the ask asks for, or Stripe answering a replayed
 * key. The rule is `INV-MOD-060`.
 */
import type { Prisma } from "@prisma/client";

import type { PaymentStore } from "@/lib/payment-transactions";

/**
 * Thrown by an ask write that finds the intent's row already naming a
 * different edit. The caller's failure path keeps the debt, so the recovery
 * retries and, still refused, alerts an officer.
 */
export class AdditionalAskAttributionConflictError extends Error {
  constructor(readonly paymentIntentId: string, readonly bookingModificationId: string) {
    super(
      `PaymentIntent ${paymentIntentId} is already recorded for another edit's ask; not writing it as ${bookingModificationId}'s (#4036)`,
    );
    this.name = "AdditionalAskAttributionConflictError";
  }
}

/**
 * The one atomic rule: update the intent's row only where it names this edit
 * or none; else insert it; else refuse. Each step is one statement, so under
 * READ COMMITTED a concurrent writer cannot slip between a check and the write:
 * the guarded `updateMany` re-evaluates its WHERE on the row it locks, and
 * `createMany` with `skipDuplicates` (`ON CONFLICT DO NOTHING`) waits for a
 * concurrent insert of the same intent rather than aborting the caller's
 * transaction (a caught `P2002` would), after which the guarded update is tried
 * once more against the row that won. A row naming no edit (a webhook's, say)
 * is still claimed, as the upsert did.
 */
export async function writeEditAttributedTransaction(
  store: PaymentStore,
  {
    paymentIntentId,
    bookingModificationId,
    create,
    update,
  }: {
    paymentIntentId: string;
    bookingModificationId: string;
    create: Prisma.PaymentTransactionUncheckedCreateInput;
    update: Prisma.PaymentTransactionUncheckedUpdateManyInput;
  },
): Promise<void> {
  const ours = {
    stripePaymentIntentId: paymentIntentId,
    OR: [{ bookingModificationId: null }, { bookingModificationId }],
  };
  if ((await store.paymentTransaction.updateMany({ where: ours, data: update })).count === 1) return;
  if ((await store.paymentTransaction.createMany({ data: [create], skipDuplicates: true })).count === 1) return;
  if ((await store.paymentTransaction.updateMany({ where: ours, data: update })).count === 1) return;
  throw new AdditionalAskAttributionConflictError(paymentIntentId, bookingModificationId);
}
