import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT } from "@/lib/manual-refund-task-settlement-rules";
import { organiserCardAppealCeilingFor } from "@/lib/organiser-child-refund";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { openCardRefundOwedByOperation, type CardRefundOwedPaymentRow } from "@/lib/open-card-refund-owed";
import { buildRefundRequestRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";

/**
 * #4117 (`INV-PAY-128`): what an approved appeal's card refund still owes - its
 * recovery row's unmade part, read as "Refunds owed" reads it - so the screen
 * shows what was refunded, not only what was approved.
 */
function appealCardRefundOwedCents(requestId: string, payment: CardRefundOwedPaymentRow): number {
  const key = buildRefundRequestRefundRecoveryIdempotencyKey(requestId);
  const operation = payment.recoveryOperations.find((each) => each.idempotencyKey === key);
  return operation ? (openCardRefundOwedByOperation(payment).get(operation.id) ?? 0) : 0;
}

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = status === "ALL" ? {} : { status };

  const [requests, total] = await Promise.all([
    prisma.refundRequest.findMany({
      where,
      include: {
        booking: {
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            finalPriceCents: true,
            status: true,
            // #2259: the review queue's notify prompt must not offer an email
            // choice the mailer will not honour. Admin-only route, so the field
            // never reaches a member.
            noEmails: true,
            // #3956: whether the group organiser paid for it by card.
            organiserSettled: true,
            parentBookingId: true,
            creditsFromCancellation: {
              select: {
                amountCents: true,
                description: true,
                // The restore test reads both (`isCancellationCreditRestoreRow`).
                type: true,
                restoredFromBookingId: true,
              },
            },
            payment: {
              select: {
                // #2932: the screen derives its refund ceiling through
                // `getRemainingRefundableCents`, which answers 0 unless the
                // payment actually captured. #3827 (`INV-PAY-118`): less every
                // hand-back still open on the payment and the late-cash credit
                // in `creditsFromCancellation` above (`refundAppealCeiling`),
                // the figure the approve route caps at.
                id: true,
                source: true,
                status: true,
                amountCents: true,
                refundedAmountCents: true,
                stripePaymentIntentId: true,
                manualRefundTasks: OPEN_HAND_BACKS_FOR_REFUND_APPEAL_SELECT,
                // #4117: read for `appealCardRefundOwedCents`, not returned.
                ...netCollectedCardRefundSelect,
              },
            },
          },
        },
        member: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.refundRequest.count({ where }),
  ]);

  // #3956 (`INV-PAY-123`): a pending appeal on a booking the group organiser
  // paid for by card is capped at what the organiser's combined payment can
  // still return - the approve route's own cap, read here unlocked as advice -
  // so the screen offers the figure the approval will accept.
  const data = await Promise.all(
    requests.map(async (withOwed) => {
      const fullPayment = withOwed.booking.payment;
      let payment: Omit<NonNullable<typeof fullPayment>, "recoveryOperations" | "refunds"> | null = null;
      if (fullPayment) {
        const { recoveryOperations: _operations, refunds: _refunds, ...rest } = fullPayment;
        payment = rest;
      }
      const request = {
        ...withOwed,
        cardRefundOwedCents:
          withOwed.status === "APPROVED" && fullPayment ? appealCardRefundOwedCents(withOwed.id, fullPayment) : 0,
        booking: { ...withOwed.booking, payment },
      };
      if (request.status !== "PENDING" || !fullPayment) return request;
      const organiserCard = await organiserCardAppealCeilingFor(prisma, withOwed.booking, fullPayment);
      if (organiserCard === null) return request;
      return {
        ...request,
        booking: {
          ...request.booking,
          organiserCardMaxRefundableCents: organiserCard.ceilingCents,
          organiserCardCombinedRefundPending: organiserCard.combinedRefundPending,
        },
      };
    }),
  );

  return NextResponse.json({ data, page, pageSize, total });
}
