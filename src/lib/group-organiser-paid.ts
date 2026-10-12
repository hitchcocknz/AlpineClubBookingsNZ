/**
 * "The organiser has paid" for an organiser-pays group — defined ONCE
 * (#3672, `INV-PAY-109`, `INV-SSOT`), for the server rule and the organiser's
 * card alike.
 *
 * Paid is a settlement that took the organiser's money and did not hand all of
 * it back: SUCCEEDED or PARTIALLY_REFUNDED (orchestrator decision 2 on #3672).
 * REFUNDED is unpaid: on a live group it is a capture refunded before it
 * settled anyone, so the organiser still owes. PARTIALLY_REFUNDED is written by
 * the organiser cancel and, since #3653, by a joiner's reduction refunded out of
 * the combined payment - a live group that is still paid for, which is why it
 * counts as paid here.
 *
 * Client-safe: plain strings, checked against the Prisma enum by type only.
 *
 * NOT the settle paths' replay guard. `group-settlement.ts` asks "did THIS
 * settlement's apply already run?", which is SUCCEEDED alone, and a
 * refund-history settlement is re-minted rather than treated as paid there.
 */
import type { PaymentStatus } from "@prisma/client";

export const ORGANISER_PAID_SETTLEMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
] as const satisfies readonly PaymentStatus[];

export function organiserHasPaidSettlement(
  settlement: { status: string } | null | undefined
): boolean {
  return (
    settlement != null &&
    (ORGANISER_PAID_SETTLEMENT_STATUSES as readonly string[]).includes(settlement.status)
  );
}

/**
 * #3653 (`INV-PAY-114`): what a joiner is told when an edit would raise the
 * price of a booking the organiser paid for by card. Every door that refuses
 * that charge - the edit saves and the quote that previews them - says this.
 */
export const ORGANISER_CHILD_CHARGE_REFUSAL =
  "This booking was paid for by the group organiser, so a change that raises its price cannot be charged here. Contact the club to make this change.";

/**
 * #3956 (`INV-PAY-123`): the line the admin review screen and the member's
 * appeal form show under a refund appeal's ceiling when the booking was paid
 * for by the group organiser's card, so neither reads that ceiling as the
 * booking's own payment.
 */
export const ORGANISER_CARD_APPEAL_CEILING_NOTE =
  "Refunded to the group organiser's card; the most that payment can still return for this booking.";

/**
 * #3956 review round 3: while the group cancellation's own refund to the
 * organiser's card is still being made, an appeal's ceiling reads zero only for
 * now. The two lines say so - to the officer on the review screen, and to the
 * member on the booking page and in the appeal route's refusal - so neither
 * reads a wait as "nothing left to refund".
 */
export const ORGANISER_CARD_APPEAL_PENDING_ADMIN_NOTE =
  "The group cancellation's refund to the organiser's card is still being made or reconciled. Approve this once it is made.";
export const ORGANISER_CARD_APPEAL_PENDING_MEMBER_NOTE =
  "The group's cancellation refund is still being processed; you can appeal once it has been made.";

/**
 * #3653 (`INV-PAY-114`): a joiner's booking the organiser paid for BY CARD - an
 * organiser-settled child whose payment mirror came from the group's combined
 * Stripe payment. Its reductions and cancellation go back to the organiser's
 * card, never to the joiner as account credit. A child the organiser settled
 * by Internet Banking is not one: no card money moved, and its group-invoice
 * settlement belongs to #3642. The settle path writes the child's mirror with
 * the settlement's source, so the mirror's source is the answer here.
 */
export function paidByOrganiserCard(booking: {
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: { source: string } | null;
}): boolean {
  return (
    booking.organiserSettled &&
    booking.parentBookingId != null &&
    booking.payment?.source === "STRIPE"
  );
}
