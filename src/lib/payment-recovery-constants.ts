import type { PaymentRecoveryOperationStatus, Prisma } from "@prisma/client";

// Shared payment-recovery constants kept in a dependency-light module so health
// and visibility code can reuse them without importing the full payment-recovery
// service (which pulls in Stripe and the email/transaction layers).

// A recovery operation is retried while attempts < this maximum; once attempts
// reach it the operation is terminal and will never be reclaimed.
export const MAX_PAYMENT_RECOVERY_ATTEMPTS = 5;

/**
 * IS A RECOVERY OPERATION STILL IN FLIGHT — will the runner still make it?
 * (#3854 K1): `PENDING` and `PROCESSING`, and a `FAILED` row with a retry
 * still scheduled (`nextRetryAt` set) and attempts left. A `FAILED` row with
 * no retry scheduled, or at the attempt ceiling, is DEAD: the money it was to
 * move will not move without a person, so it is never read as in flight.
 *
 * `PENDING` counts REGARDLESS of `nextRetryAt` and `attempts`, deliberately:
 * the runner's claim additionally requires `nextRetryAt <= now` and
 * `attempts < MAX` (`claimPaymentRecoveryOperation`), but a `PENDING` row is
 * one enqueued or re-armed to run, not one the runner gave up on, and this
 * predicate answers "not yet dead", not "claimable this instant".
 *
 * Its readers: the booking-ledger projection census — the in-flight refund
 * class (`booking-ledger-projection-census-classes.ts`) and the snapshot's
 * per-operation flag (`booking-ledger-projection-census-store.ts`) - and the
 * refund-requests screen's retrying-or-dead read of an approved appeal's card
 * refund (`refund-appeal-outcome.ts`, #4117). Two
 * readers deliberately use a different rule and do not route through this:
 * `isEditFinancialReviewChargeRecoveryDead` (`payment-recovery.ts`, #3402) and
 * `unfinishedCardRefundDebts` (`edit-financial-review-cancel-netting.ts`,
 * #3835, its Prisma-filter twin) read a row in a claimable status (`PENDING`
 * OR `FAILED`) with no retry time or its attempts spent as DEAD — the re-arm
 * leaves such a row (`INV-PAY-057`), so for them a stranded `PENDING` row is a
 * person's to settle, where this predicate still counts it in flight. A third
 * reader routes through this one and adds that rule beside it: the card refund
 * shortfall's completion guard (`cardShortfallSettlement`,
 * `cancel-card-refund-shortfall-settle.ts`, #4097) reads a claimable row at the
 * attempt ceiling as stopped - the "Paid another way" close's own rule
 * (`deadCardRefundOperationWhere`) - so its refusal points at that close
 * rather than at a retry that will never come.
 */
export function isPaymentRecoveryOperationInFlight(operation: {
  status: PaymentRecoveryOperationStatus;
  attempts: number;
  nextRetryAt: Date | null;
}): boolean {
  if (operation.status === "PENDING" || operation.status === "PROCESSING") return true;
  return operation.status === "FAILED" && operation.nextRetryAt !== null && operation.attempts < MAX_PAYMENT_RECOVERY_ATTEMPTS;
}

/**
 * #4036 review: {@link isPaymentRecoveryOperationInFlight} as a Prisma filter,
 * for a reader that must find the in-flight rows in the database. Its twin, not
 * a second rule: the reader still applies the predicate to what it reads, and
 * `payment-recovery-constants.test.ts` holds the two to the same rows.
 */
export const PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE = {
  OR: [
    { status: { in: ["PENDING", "PROCESSING"] } },
    { status: "FAILED", nextRetryAt: { not: null }, attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS } },
  ],
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/**
 * #4104 review (ops 7): a recovery the runner will never claim again - in a
 * claimable status with its attempts spent - as a Prisma filter. A card refund
 * raised dead (`card-refund-failed-later.ts`) is PENDING with its attempts
 * spent, so "exhausted" is read on both statuses, and a queue that is only
 * waiting on dead rows is not a stalled cron (`PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE`).
 */
export const PAYMENT_RECOVERY_EXHAUSTED_WHERE = {
  status: { in: ["PENDING", "FAILED"] },
  attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
} satisfies Prisma.PaymentRecoveryOperationWhereInput;

/** The other side of it: a row the runner's claim can still take, once its retry time comes. */
export const PAYMENT_RECOVERY_CLAIMABLE_LATER_WHERE = {
  attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS },
  nextRetryAt: { not: null },
} satisfies Prisma.PaymentRecoveryOperationWhereInput;
