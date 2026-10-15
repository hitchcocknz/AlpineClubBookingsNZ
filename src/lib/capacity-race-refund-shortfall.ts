/**
 * #4125: A CAPACITY-RACE REFUND SHORT OF THE CHARGE IS THE OFFICERS' TO FOLLOW UP.
 *
 * A payment that completes after the final capacity claim failed is cancelled
 * and refunded by card for what the payment ledger shows refundable
 * (`plannedRefundCents`, `payment-reconciliation.ts`). Mirror-vs-ledger drift
 * can make that less than the charge, or nothing at all. The rest is neither
 * refunded nor retained, and the member's booking page says the club will be in
 * touch about it (`booking-narrative-cancelled-post-payment.ts`). This is what
 * backs that sentence: the officers are told, once ever per booking, how much
 * was not refunded automatically and that it is theirs to check and settle.
 *
 * Once ever through the one rule (`sendAdminAlertOnceEver`): a send that
 * reached an admin keeps its claim, so a redelivered webhook never repeats it.
 * A send that threw gives the claim back, but nothing re-runs this - the
 * capacity race happens once - so that loss is logged, and the booking page
 * still says the club will be in touch.
 *
 * Not a card refund shortfall task (#4097, `cardShortfall`): that pattern
 * raises a bank-transfer hand-back inside the cancel's claim, sized from a
 * policy refund; here the gap is drift the treasurer must first check, which
 * may already have gone back by another route.
 */
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import logger from "@/lib/logger";
import { alertPaymentRecoveryOfficers, NOBODY_ALERTED } from "@/lib/payment-recovery-alert";
import { formatCents } from "@/lib/utils";

/** The once-ever alert's key: one per booking, whatever the intent. */
export function capacityRaceRefundShortfallAlertKey(bookingId: string): string {
  return `capacity-race-refund-shortfall:${bookingId}`;
}

/** The alert's text, naming what was refunded automatically and what is left. */
export function capacityRaceRefundShortfallMessage(
  { chargedCents, plannedRefundCents }: { chargedCents: number; plannedRefundCents: number },
  format: ClubFormat,
): string {
  const money = (cents: number) => formatCents(cents, format);
  const remainder = money(chargedCents - plannedRefundCents);
  const lead = "The dates filled up while this card payment was going through, so the booking was cancelled.";
  const refunded =
    plannedRefundCents > 0
      ? `The payment's records showed only ${money(plannedRefundCents)} of the ${money(chargedCents)} charge refundable, so that is being refunded to the card automatically and the remaining ${remainder} is not.`
      : `The payment's records showed nothing of the ${money(chargedCents)} charge refundable by card, so none of it was refunded automatically.`;
  return `${lead} ${refunded} Check the payment and refund the member the ${remainder} by hand if it has not already gone back. The member's booking page says the club will be in touch about it.`;
}

/**
 * Tell the officers, once ever, about the part of a capacity-race charge no
 * card refund covers. Nothing when the plan covers the charge. Never throws.
 */
export async function alertCapacityRaceRefundShortfall(
  input: { bookingId: string; paymentIntentId: string; chargedCents: number; plannedRefundCents: number },
  format: ClubFormat,
): Promise<boolean> {
  const remainderCents = input.chargedCents - input.plannedRefundCents;
  if (remainderCents <= 0) return false;
  const context = { bookingId: input.bookingId, paymentIntentId: input.paymentIntentId, chargedCents: input.chargedCents, plannedRefundCents: input.plannedRefundCents };
  logger.error(context, "Capacity-race refund plan covers less than the captured amount; refunding what the payment ledger shows refundable");
  return sendAdminAlertOnceEver({
    key: capacityRaceRefundShortfallAlertKey(input.bookingId),
    label: "capacity-race refund shortfall alert",
    context,
    send: async () =>
      (await alertPaymentRecoveryOfficers(
        {
          bookingId: input.bookingId,
          amountCents: remainderCents,
          paymentIntentId: input.paymentIntentId,
          errorMessage: capacityRaceRefundShortfallMessage(input, format),
        },
        format,
      )) ?? NOBODY_ALERTED,
  });
}
