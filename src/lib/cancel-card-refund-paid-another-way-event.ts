/**
 * #4145 (`INV-PAY-133`): A MEMBER CANCEL'S CARD REFUND CLOSED "PAID ANOTHER WAY"
 * AFTER PART OF IT WENT BACK TO THE CARD.
 *
 * The cancel's REFUNDED event is written by the close that records the refund
 * made (`closeRefundRowRecordingEvent`). A row whose retries ran out after some
 * of its slices were made - inline, or by an earlier attempt - is closed by an
 * officer instead (`closeCardRefundPaidAnotherWay`), for what it still owes.
 * The part Stripe made did go back to the card, and nothing else records it for
 * the member: so that close records it here, in its own transaction, as the
 * cancel's card refund event for that part (`recordCancelCardRefundEvent`) -
 * and the booking page says the two parts apart. Nothing made, nothing written:
 * the whole refund was paid back another way.
 */
import type { Prisma } from "@prisma/client";

import { recordCancelCardRefundEvent } from "@/lib/booking-events";
import type { ClubFormat } from "@/lib/club-format";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { buildBookingCancellationRefundIdempotencyKey } from "@/lib/payment-recovery-keys";

/**
 * `ownCents` is what the row's own slices still had unsent when it was closed
 * (`stillOwed`), so the rest of its amount - the plan's total - went back to
 * the card. Dated by the latest refund its plan marks made (`madeRefundId`);
 * with none marked, by the close.
 */
export async function recordCancelCardRefundMadeBeforePaidAnotherWay(
  tx: Prisma.TransactionClient,
  operation: { idempotencyKey: string; bookingId: string; paymentId: string; amountCents: number; allocationPlan: Prisma.JsonValue },
  { ownCents, format }: { ownCents: number; format: ClubFormat },
): Promise<boolean> {
  if (operation.idempotencyKey !== buildBookingCancellationRefundIdempotencyKey(operation.bookingId)) return false;
  const madeCents = operation.amountCents - ownCents;
  if (madeCents <= 0) return false;
  const madeRefundIds = (parseRefundAllocationPlan(operation.allocationPlan) ?? []).flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : []));
  const made = await tx.paymentRefund.findMany({
    where: { paymentId: operation.paymentId, stripeRefundId: { in: madeRefundIds } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { createdAt: true },
  });
  return recordCancelCardRefundEvent(tx, {
    bookingId: operation.bookingId,
    amountCents: madeCents,
    actorMemberId: null,
    part: true,
    format,
    occurredAt: made[0]?.createdAt,
  });
}
