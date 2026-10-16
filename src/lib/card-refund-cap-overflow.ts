import { createHash } from "crypto";

import type { Prisma } from "@prisma/client";

import { compareOrdinal } from "@/lib/ordinal-order";
import logger from "@/lib/logger";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
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
 * The member may have been paid back twice - or (round 3) the charge's
 * records already read fully refunded with no hand-back behind it: record
 * drift, or account credit given back. The alert says which. The cap keeps
 * the ledger whole, so nothing else would ever show it: the officers are told,
 * once per charge and set of counted refunds (a replay of the same refunds
 * alerts nothing new, any new refund does),
 * through the payment recovery alert, after the refund's own commit - never
 * inside it. The alert's claim (`sendAdminAlertOnceEver`) and the email row are
 * the durable record; the error log stays beside them.
 */
export type CardRefundCapOverflow = {
  paymentId: string;
  paymentTransactionId: string;
  discardedCents: number;
  /** The charge's recorded, non-refused card refunds when the cap discarded. */
  recordedRefundCents: number;
  /** Round 3 (4): the Stripe ids of those refunds - the alert's key, in any order. */
  countedRefundIds: readonly string[];
};

export function cardRefundCapOverflowAlertKey(overflow: CardRefundCapOverflow): string {
  const refunds = createHash("sha256").update([...overflow.countedRefundIds].sort(compareOrdinal).join(",")).digest("hex").slice(0, 24);
  return `card-refund-cap-overflow:${overflow.paymentTransactionId}:${refunds}`;
}

/**
 * The overflow a refund write's cap discarded, or null: logged as an error here, inside the write's transaction; the
 * officers are alerted after its commit (`alertCardRefundCapOverflow`). Round 3 (4): it names the refunds the charge
 * counts, which key the alert, so a replay of them alerts nothing new and any new refund does.
 */
export async function readCardRefundCapOverflow(
  db: Pick<Prisma.TransactionClient, "paymentRefund">,
  params: Omit<CardRefundCapOverflow, "countedRefundIds"> & { previousCents: number; nextCents: number },
): Promise<CardRefundCapOverflow | null> {
  const { previousCents, nextCents, ...overflow } = params;
  if (overflow.discardedCents <= 0) return null;
  logger.error({ ...overflow, previousCents, nextCents }, "A card refund took this charge's refunded total past the charge; the excess was discarded - check whether the member was also paid back another way (#4154)");
  const counted = await db.paymentRefund.findMany({
    where: { paymentTransactionId: overflow.paymentTransactionId, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
    select: { stripeRefundId: true },
  });
  return { ...overflow, countedRefundIds: counted.map((row) => row.stripeRefundId) };
}

/** Round 3 (3): "paid twice" only where money went back by hand on the payment; otherwise the records drifted. */
export function cardRefundCapOverflowMessage(discarded: string, handBack: boolean): string {
  const lead = `A card refund took this booking's card charge past what was charged: ${discarded} of refunds could not be recorded against it.`;
  return handBack
    ? `${lead} The charge already reads refunded by a hand-back marked paid back or a card refund closed as Paid another way, so the member may have been paid back twice - by card and by hand. Check the charge in Stripe and the bank transfers, and recover any overpayment from the member.`
    : `${lead} The charge's records already read it fully refunded, with no hand-back behind it (record drift, or account credit given back). Check the charge in Stripe against the booking's payment records.`;
}

/** Tell the officers, once per charge and set of counted refunds. After the commit; never throws. */
export async function alertCardRefundCapOverflow(overflow: CardRefundCapOverflow): Promise<boolean> {
  const context = { ...overflow };
  try {
    const row = await prisma.paymentTransaction.findUnique({
      where: { id: overflow.paymentTransactionId },
      select: { stripePaymentIntentId: true, payment: { select: { bookingId: true } } },
    });
    // A hand-back or "Paid another way" close completed on the payment: bank money already in the total.
    const handBacks = await prisma.manualRefundTask.count({ where: { paymentId: overflow.paymentId, kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED" } });
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
            errorMessage: cardRefundCapOverflowMessage(formatCents(overflow.discardedCents, format), handBacks > 0),
          },
          format,
        )) ?? NOBODY_ALERTED,
    });
  } catch (err) {
    logger.error({ ...context, err }, "Could not alert the officers to a card refund past its charge (#4159)");
    return false;
  }
}
