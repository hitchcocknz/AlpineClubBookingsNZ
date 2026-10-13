/**
 * #4117 (`INV-PAY-128`): WHAT AN APPROVED REFUND APPEAL HAS STILL TO GIVE BACK,
 * for the refund-requests screen, so its "Refunded" figure is what went back
 * rather than what was approved.
 *
 * - By card, through the request's recovery row: its unmade part, read as
 *   "Refunds owed" reads it (`openCardRefundOwedByOperation`) and capped per
 *   payment the same way (`openCardRefundOwedCents`). The row is retrying while
 *   the runner will still make it (`isPaymentRecoveryOperationInFlight`), and
 *   dead after that, owed until the treasurer closes it as paid another way.
 * - By card, with no row: when none could be written after Stripe was asked,
 *   the approval's audit row records what was not made, refused and unanswered
 *   (`RefundRequestCardRefundAnswer`) - the only durable record of it.
 * - By bank transfer: this request's own hand-back task while it is OPEN
 *   (`refundRequestHandBackOccurrenceKey`, `INV-PAY-118`).
 *
 * Read-only, three queries for a page of requests.
 */
import { PaymentRecoveryOperationStatus, type PrismaClient } from "@prisma/client";

import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { refundRequestHandBackOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { openCardRefundOwedByOperation, openCardRefundOwedCents } from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { buildRefundRequestRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";

/** Where an approved appeal's card refund stands. */
export type AppealCardRefundState = "made" | "retrying" | "dead" | "not_queued";

export interface ApprovedAppealOutcome {
  cardRefundState: AppealCardRefundState;
  /** Not yet given back by card. */
  cardRefundOwedCents: number;
  /** When not queued: of that, refused by Stripe (certainly not made) and unanswered (it may have been made). */
  cardRefundRefusedCents: number;
  cardRefundUnansweredCents: number;
  /** Promised back by bank transfer, its task still open. */
  handBackOwedCents: number;
}

const MADE: ApprovedAppealOutcome = {
  cardRefundState: "made",
  cardRefundOwedCents: 0,
  cardRefundRefusedCents: 0,
  cardRefundUnansweredCents: 0,
  handBackOwedCents: 0,
};

/** The approve route's audit of a card refund no retry was queued for, or null. */
function unqueuedCardRefund(metadata: unknown): Pick<ApprovedAppealOutcome, "cardRefundOwedCents" | "cardRefundRefusedCents" | "cardRefundUnansweredCents"> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const cents = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
  if (record.cardRefundQueued !== false || cents(record.cardRefundOwedCents) === 0) return null;
  return {
    cardRefundOwedCents: cents(record.cardRefundOwedCents),
    cardRefundRefusedCents: cents(record.cardRefundRefusedCents),
    cardRefundUnansweredCents: cents(record.cardRefundUnansweredCents),
  };
}

type OutcomeStore = Pick<PrismaClient, "payment" | "auditLog" | "manualRefundTask">;

export async function readApprovedAppealOutcomes(
  db: OutcomeStore,
  requests: ReadonlyArray<{ id: string; status: string; booking: { payment: { id: string } | null } }>,
): Promise<Map<string, ApprovedAppealOutcome>> {
  const approved = requests.filter((request) => request.status === "APPROVED");
  const outcomes = new Map<string, ApprovedAppealOutcome>();
  if (approved.length === 0) return outcomes;
  const paymentIds = approved.flatMap((request) => (request.booking.payment ? [request.booking.payment.id] : []));
  const [payments, audits, handBacks] = await Promise.all([
    paymentIds.length
      ? db.payment.findMany({
          where: { id: { in: paymentIds } },
          select: {
            id: true,
            status: true,
            amountCents: true,
            refundedAmountCents: true,
            refunds: netCollectedCardRefundSelect.refunds,
            recoveryOperations: {
              where: netCollectedCardRefundSelect.recoveryOperations.where,
              select: { ...netCollectedCardRefundSelect.recoveryOperations.select, attempts: true, nextRetryAt: true },
            },
          },
        })
      : [],
    db.auditLog.findMany({
      where: { action: "refund-request.approve", entityType: "RefundRequest", entityId: { in: approved.map((request) => request.id) } },
      select: { entityId: true, metadata: true },
    }),
    db.manualRefundTask.findMany({
      where: { occurrenceKey: { in: approved.map((request) => refundRequestHandBackOccurrenceKey(request.id)) }, status: "OPEN" },
      select: { occurrenceKey: true, amountCents: true },
    }),
  ]);
  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));
  for (const request of approved) {
    const handBackOwedCents = handBacks
      .filter((task) => task.occurrenceKey === refundRequestHandBackOccurrenceKey(request.id))
      .reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    const payment = request.booking.payment ? paymentById.get(request.booking.payment.id) : undefined;
    const key = buildRefundRequestRefundRecoveryIdempotencyKey(request.id);
    const operation = payment?.recoveryOperations.find((each) => each.idempotencyKey === key);
    if (payment && operation) {
      const owedCents = Math.min(openCardRefundOwedByOperation(payment).get(operation.id) ?? 0, openCardRefundOwedCents(payment));
      const open = operation.status !== PaymentRecoveryOperationStatus.SUCCEEDED && owedCents > 0;
      outcomes.set(request.id, {
        ...MADE,
        cardRefundState: !open ? "made" : isPaymentRecoveryOperationInFlight(operation) ? "retrying" : "dead",
        cardRefundOwedCents: open ? owedCents : 0,
        handBackOwedCents,
      });
      continue;
    }
    const unqueued = unqueuedCardRefund(audits.find((audit) => audit.entityId === request.id)?.metadata);
    outcomes.set(request.id, unqueued ? { ...MADE, ...unqueued, cardRefundState: "not_queued", handBackOwedCents } : { ...MADE, handBackOwedCents });
  }
  return outcomes;
}
