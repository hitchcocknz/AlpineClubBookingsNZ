import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bookingAmountOwedCents } from "@/lib/booking-payment-state";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";

/**
 * What a payable booking still owes, read for a booking row already in hand
 * (#4058, `INV-PAY-119`): its price plus a change fee recorded on its payment,
 * less the credit applied to it. The one reader for every surface that QUOTES
 * the amount to a member — the `/pay/<token>` page and the pay-link emails —
 * so the page and the email a member opens it from cannot disagree. The pure
 * arithmetic stays in `bookingAmountOwedCents`; this adds the two reads it
 * needs.
 *
 * `owedCents` can go to or below zero (credit covers it all); `dueCents` is
 * that figure floored at zero, for a line that says what to pay.
 *
 * No `server-only` import: `payment-link-context.ts` is reachable from
 * `src/instrumentation.node.ts`, where it throws.
 */
export async function readBookingAmountOwed(
  booking: {
    id: string;
    finalPriceCents: number;
    payment: { changeFeeCents: number | null } | null;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<{ owedCents: number; dueCents: number; appliedCreditCents: number }> {
  const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id, db);
  const owedCents = bookingAmountOwedCents({
    finalPriceCents: booking.finalPriceCents,
    changeFeeCents: booking.payment?.changeFeeCents ?? null,
    appliedCreditCents,
  });
  return { owedCents, dueCents: Math.max(0, owedCents), appliedCreditCents };
}
