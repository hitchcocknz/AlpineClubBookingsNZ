import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  CLOSE_ALREADY_PAID_REASON_MAX,
  isChargeClosableAsAlreadyPaid,
  isChargeClosedAsAlreadyPaid,
  PARTLY_PAID_CHARGE_ADVICE,
  SUBSCRIPTION_ALREADY_PAID_CODE,
} from "@/lib/subscription-charge-already-paid";
import { findLiveSubscriptionInvoiceOperation } from "@/lib/xero-subscription-invoices";

/**
 * #4098: an officer closes a membership subscription charge the invoice worker
 * left in `CONFLICT` / `SUBSCRIPTION_ALREADY_PAID`, because every subscription
 * it covers was paid another way (usually a manual mark-paid). Retry can never
 * clear such a charge: the worker refuses to invoice a PAID subscription.
 *
 * WHAT IT WRITES, in one transaction:
 *
 *  1. The charge, `CONFLICT` -> `NOT_REQUIRED` — the status whose lifecycle
 *     meaning is "this charge needs no invoice and no provider work". `VOIDED`
 *     is not used: it records an invoice Xero voided, and this charge never had
 *     one. Confirmation writes `NOT_REQUIRED` only for a `NO_INVOICE` charge, so
 *     `isChargeClosedAsAlreadyPaid` tells the two apart without a schema change.
 *  2. Every covered subscription must still be `PAID`; the same guarded write
 *     bumps its `voidGeneration`.
 *  3. The charge's ACTIVE coverage claims are released (`releasedAt` set, rows
 *     kept), as the void path does (#2147).
 *  4. An audit row naming the officer, the reason, the charge and the
 *     subscriptions.
 *
 * WHY THE CLAIMS ARE RELEASED. An active claim means "this member's season is
 * billed on this charge", and after the close it is not: it was paid outside
 * the charge. Releasing the claims and bumping `voidGeneration` leaves each
 * subscription exactly as a member marked paid before any billing run (PAID,
 * no invoice link, no active claim). While it stays PAID every preview skips it
 * on status alone. If the manual payment is later reversed, the member is
 * re-billable: no claim hides them from the preview, and the bumped generation
 * gives the new charge a fresh idempotency key. Keeping the claims would leave a
 * reversed member silently unbillable, and without the bump a re-bill would
 * collapse onto this closed charge's key and raise nothing. A PER_FAMILY charge
 * is the exception: the preview still counts the closed row as the family's
 * charge (FAMILY_ALREADY_BILLED), because a second family charge would collide
 * with the family/type/season unique index (#4110).
 *
 * GUARDS AND RACES. No advisory lock, like the void release and the family
 * markers: every write is guarded in its own WHERE. The charge claim is a
 * status-guarded `updateMany` (`CONFLICT` + the code + no invoice), so a double
 * click or two officers close once — the loser waits on the row, then matches
 * nothing and reads the charge already closed. The subscription write matches
 * only PAID rows and must touch every one; a manual reversal that committed
 * first makes it fall short and the whole transaction rolls back, and one that
 * arrives later waits on the row and then finds the member re-billable. The
 * close is refused while an invoice operation for the charge is live (queued,
 * running or awaiting payment): a worker mid-Xero-call writes back after the
 * provider responds without a status guard, and during a rollout an old pod's
 * worker does not know the closed status at all. What remains is a Retry or
 * enqueue that creates or re-pends an operation concurrently with the close. It
 * cannot reopen the charge: the enqueue's status write, the worker's own
 * already-paid conflict write and the outbox failure handler's write all
 * exclude `NOT_REQUIRED`, and a new worker skips a `NOT_REQUIRED` charge. An
 * old pod during a rollout could still process that operation; that is a
 * stated limit.
 */

export class CloseAlreadyPaidChargeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "CloseAlreadyPaidChargeError";
  }
}

export type CloseAlreadyPaidChargeResult = {
  /** False when the charge was already closed (an idempotent repeat). */
  closed: boolean;
  message: string;
};

const ALREADY_CLOSED_MESSAGE = "This charge is already closed as paid.";

export async function closeAlreadyPaidSubscriptionCharge(input: {
  chargeId: string;
  reason: string;
  actorMemberId: string;
}): Promise<CloseAlreadyPaidChargeResult> {
  const reason = input.reason.trim().slice(0, CLOSE_ALREADY_PAID_REASON_MAX);
  if (!reason) {
    throw new CloseAlreadyPaidChargeError("Give a reason for closing this charge.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const charge = await tx.membershipSubscriptionCharge.findUnique({
      where: { id: input.chargeId },
      select: {
        id: true,
        seasonYear: true,
        status: true,
        billingBasis: true,
        lastErrorCode: true,
        xeroInvoiceId: true,
        coverage: {
          where: { releasedAt: null },
          select: {
            subscriptionId: true,
            memberName: true,
            subscription: { select: { status: true, memberId: true } },
          },
        },
      },
    });
    if (!charge) {
      throw new CloseAlreadyPaidChargeError("Subscription charge not found.", 404);
    }
    if (isChargeClosedAsAlreadyPaid(charge)) {
      return { closed: false, message: ALREADY_CLOSED_MESSAGE };
    }
    if (!isChargeClosableAsAlreadyPaid(charge)) {
      throw new CloseAlreadyPaidChargeError(
        "Only a charge in conflict because its subscription is already paid can be closed as already paid.",
        409,
      );
    }
    if (charge.coverage.length === 0) {
      throw new CloseAlreadyPaidChargeError(
        "This charge covers no subscription, so there is nothing to close as paid.",
        409,
      );
    }
    const unpaid = charge.coverage.filter((row) => row.subscription.status !== "PAID");
    if (unpaid.length > 0) {
      throw new CloseAlreadyPaidChargeError(
        `Still unpaid: ${unpaid.map((row) => row.memberName).join(", ")}. ${PARTLY_PAID_CHARGE_ADVICE}`,
        409,
      );
    }

    // A live invoice operation may be a worker mid-Xero-call, whose writes after
    // the provider responds are not status-guarded; let it finish first.
    if (await findLiveSubscriptionInvoiceOperation(tx, charge.id)) {
      throw new CloseAlreadyPaidChargeError(
        "A Xero invoice attempt for this charge is still queued or running. Wait for it to finish (see Xero Operations), then close the charge.",
        409,
      );
    }

    // The single-winner claim. A concurrent close blocks on this row and then
    // matches nothing, because the status it needs is gone.
    const claimed = await tx.membershipSubscriptionCharge.updateMany({
      where: {
        id: charge.id,
        status: "CONFLICT",
        lastErrorCode: SUBSCRIPTION_ALREADY_PAID_CODE,
        xeroInvoiceId: null,
      },
      data: { status: "NOT_REQUIRED", lastErrorCode: null, lastErrorMessage: null },
    });
    if (claimed.count === 0) {
      const current = await tx.membershipSubscriptionCharge.findUnique({
        where: { id: charge.id },
        select: { status: true, billingBasis: true },
      });
      if (current && isChargeClosedAsAlreadyPaid(current)) {
        return { closed: false, message: ALREADY_CLOSED_MESSAGE };
      }
      throw new CloseAlreadyPaidChargeError(
        "This charge changed while you were closing it. Refresh and try again.",
        409,
      );
    }

    const subscriptionIds = charge.coverage.map((row) => row.subscriptionId);
    // The authoritative PAID re-read: the guard is in the WHERE, so a reversal
    // that committed after the read above leaves this short and rolls back.
    const stillPaid = await tx.memberSubscription.updateMany({
      where: { id: { in: subscriptionIds }, status: "PAID" },
      data: { voidGeneration: { increment: 1 } },
    });
    if (stillPaid.count !== subscriptionIds.length) {
      throw new CloseAlreadyPaidChargeError(
        "A covered subscription is no longer paid. Refresh, then Retry the charge to invoice it.",
        409,
      );
    }

    const released = await tx.membershipSubscriptionChargeCoverage.updateMany({
      where: { chargeId: charge.id, releasedAt: null },
      data: { releasedAt: new Date() },
    });

    await createAuditLog({
      action: "membership-subscription-billing.close-already-paid",
      category: "payment",
      entityType: "MembershipSubscriptionCharge",
      entityId: charge.id,
      memberId: input.actorMemberId,
      targetId: charge.id,
      details: JSON.stringify({
        reason,
        seasonYear: charge.seasonYear,
        previousStatus: "CONFLICT",
        status: "NOT_REQUIRED",
        subscriptionIds,
        memberIds: charge.coverage.map((row) => row.subscription.memberId),
        coverageReleased: released.count,
      }),
    }, tx);

    return { closed: true, message: "Charge closed as already paid. No Xero invoice will be raised for it." };
  });
}
