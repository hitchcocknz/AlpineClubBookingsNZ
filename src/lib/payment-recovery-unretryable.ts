/**
 * #4081: A RECOVERY FAILURE A RETRY CANNOT FIX STOPS THE RECOVERY AT ONCE.
 *
 * The recovery runner retries a failed attempt on a backoff (about seventeen
 * hours over five attempts) and alerts an officer only when the attempts run
 * out. That suits a provider outage, which passes. It does not suit a refusal
 * the next attempt will meet again, which only burns the backoff before anyone
 * hears of it.
 *
 * One such refusal today: an edit's ask write that finds its intent already
 * recorded for another edit (`AdditionalAskAttributionConflictError`,
 * `INV-MOD-060`). Edit X's recovery adopted edit Y's intent, Y's write was
 * refused, and Y's retry that re-derives the same figure (the frozen fallback,
 * say) is handed the same intent by Stripe and refused again on every attempt.
 *
 * So the runner's failure path (`failPaymentRecoveryOperation`) ends the
 * recovery on the first such failure, through the one terminal transition
 * (`markPaymentRecoveryOperationFailed`, `INV-PAY-056`): FAILED with no retry,
 * at the attempt ceiling, the cause below on `lastError` and in the officers'
 * alert. The debt stays on the row, and the stuck-state page lists it with the
 * exhausted recoveries.
 */
import { PaymentRecoveryOperationType, type PaymentRecoveryOperation } from "@prisma/client";

import { AdditionalAskAttributionConflictError } from "@/lib/payment-intent-transaction-write";

/** The officer-facing cause when `error` ends `operation` now, else null (retry as usual). */
export function unretryableRecoveryCause(
  operation: Pick<PaymentRecoveryOperation, "type">,
  error: unknown,
): string | null {
  if (
    operation.type === PaymentRecoveryOperationType.CREATE_ADDITIONAL_PAYMENT_INTENT &&
    error instanceof AdditionalAskAttributionConflictError
  ) {
    return `This ask's card payment request (${error.paymentIntentId}) is already recorded for another booking edit, so it was not recorded for edit ${error.bookingModificationId}. A retry would be refused the same way, so retries stopped. The money is still owed: check this booking's additional payments against Stripe and collect it by hand (#4081).`;
  }
  return null;
}
