import { PaymentRecoveryOperationStatus } from "@prisma/client";

import {
  CANCEL_CARD_SHORTFALL_KEY_PREFIX,
  cancelCardShortfallPart,
  closeKeysOf,
  type CardShortfallTaskStatuses,
} from "@/lib/manual-refund-task-settlement-rules";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";

/**
 * #4097 (`INV-PAY-129`): WHERE A CARD REFUND SHORTFALL'S CANCEL STANDS, for the
 * booking page and the public payment-link page, which hand it to the pure
 * narrative. Each part's task status, and - only on a cancel that has such
 * tasks - the card part's own refund: settled, still on its way, or closed as
 * "Paid another way" (its record under `closeKeysOf`).
 *
 * No `server-only` and no heavier import than Prisma: the payment-link page's
 * context module must stay importable outside a React server
 * (`cli-server-only-reach-census.test.ts`).
 */
export async function readCardShortfallTaskStatuses(bookingId: string): Promise<CardShortfallTaskStatuses> {
  const tasks = await prisma.manualRefundTask.findMany({
    where: { bookingId, occurrenceKey: { startsWith: CANCEL_CARD_SHORTFALL_KEY_PREFIX } },
    select: { kind: true, occurrenceKey: true, status: true },
  });
  const statuses: CardShortfallTaskStatuses = {};
  for (const task of tasks ?? []) {
    const part = cancelCardShortfallPart(task);
    if (part) statuses[part] = task.status;
  }
  if (Object.keys(statuses).length === 0) return statuses;
  const cardRefund = await prisma.paymentRecoveryOperation.findUnique({
    where: { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
    select: { id: true, status: true },
  });
  if (cardRefund) {
    const closed = await prisma.manualRefundTask.count({ where: { occurrenceKey: { in: closeKeysOf(cardRefund.id) } } });
    statuses.card = closed > 0 ? "paid-another-way" : cardRefund.status === PaymentRecoveryOperationStatus.SUCCEEDED ? "settled" : "on-its-way";
  }
  return statuses;
}
