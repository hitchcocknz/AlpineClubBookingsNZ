import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #4159 review round 2 (F2, `INV-PAY-134`): A CARD REFUND THE CHARGE'S
 * REFUNDED TOTAL COULD NOT HOLD.
 *
 * `recordStripeRefundsAgainstTransaction` caps a charge's refunded total at the
 * charge. Cents it has to discard are refund money already counted another
 * way - most often a hand-back or "Paid another way" close recorded by hand on
 * the same charge, then a card refund made for the same money (a capacity
 * race's hand-back whose charge Stripe refunded after the completion read it).
 * The member may have been paid back twice. The cap keeps the ledger whole,
 * so nothing else would ever show it: the officers are told, once per charge
 * and refund-row total (a replay of the same refunds alerts nothing new),
 * through the payment recovery alert, after the refund's own commit - never
 * inside it. The alert's claim (`sendAdminAlertOnceEver`) and the email row are
 * the durable record; the error log stays beside them.
 */
export type CardRefundCapOverflow = {
  paymentId: string;
  paymentTransactionId: string;
  discardedCents: number;
  /** The charge's recorded, non-refused card refunds when the cap discarded: the alert's key. */
  recordedRefundCents: number;
};

export function cardRefundCapOverflowAlertKey(overflow: CardRefundCapOverflow): string {
  return `card-refund-cap-overflow:${overflow.paymentTransactionId}:${overflow.recordedRefundCents}`;
}

export function cardRefundCapOverflowMessage(discarded: string): string {
  return `A card refund took this booking's card charge past what was charged: ${discarded} of refunds could not be recorded against it, because the charge already reads refunded by other means (most often a hand-back marked paid back, or a card refund closed as Paid another way). The member may have been paid back twice - by card and by hand. Check the charge in Stripe and the bank transfers, and recover any overpayment from the member.`;
}

/** Tell the officers, once per charge and refund-row total. After the commit; never throws. */
export async function alertCardRefundCapOverflow(overflow: CardRefundCapOverflow): Promise<boolean> {
  const context = { ...overflow };
  try {
    const row = await prisma.paymentTransaction.findUnique({
      where: { id: overflow.paymentTransactionId },
      select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } },
    });
    const bookingId = row?.payment?.bookingId ?? null;
    if (!bookingId) {
      logger.error(context, "A card refund's discarded cents have no booking to alert the officers about (#4159)");
      return false;
    }
    // Loaded here, not at the top: the payment ledger imports this module, and the alert's own imports reach back to it.
    const [{ clubFormatValues }, { alertPaymentRecoveryOfficers, NOBODY_ALERTED }, { sendAdminAlertOnceEver }] = await Promise.all([
      import("@/lib/club-format-server"),
      import("@/lib/payment-recovery-alert"),
      import("@/lib/admin-alert-once"),
    ]);
    const format = await clubFormatValues();
    return await sendAdminAlertOnceEver({
      key: cardRefundCapOverflowAlertKey(overflow),
      label: "card refund past its charge alert",
      context,
      send: async () =>
        (await alertPaymentRecoveryOfficers(
          {
            bookingId,
            amountCents: overflow.discardedCents,
            paymentIntentId: row?.stripePaymentIntentId ?? "",
            errorMessage: cardRefundCapOverflowMessage(formatCents(overflow.discardedCents, format)),
          },
          format,
        )) ?? NOBODY_ALERTED,
    });
  } catch (err) {
    logger.error({ ...context, err }, "Could not alert the officers to a card refund past its charge (#4159)");
    return false;
  }
}
