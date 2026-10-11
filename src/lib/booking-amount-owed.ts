import type { Prisma } from "@prisma/client";
import { bookingAmountOwedCents, type BookingAmountOwed } from "@/lib/booking-payment-state";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { prisma } from "@/lib/prisma";

/**
 * THE ONE READ of a booking's amount owed with its credit (#3991, `INV-SSOT`).
 *
 * The credit comes from the ledger (`deriveBookingAppliedCreditCents`, the sum
 * of the booking's `BOOKING_APPLIED` rows), which is what the card intent is
 * minted against — never from `Payment.creditAppliedCents`, which only mirrors
 * it and is absent before a payment row exists. The payment-link page, its
 * intent and the booking page each read it here, so the figure they quote and
 * the figure they charge cannot come from two different sources.
 *
 * Not `server-only`: `payment-link-context.ts` is reachable from
 * `src/instrumentation.node.ts`, where that import throws.
 */
export async function readBookingAmountOwed(
  booking: { id: string; finalPriceCents: number; payment: { changeFeeCents: number | null } | null },
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<BookingAmountOwed> {
  const appliedCreditCents = await deriveBookingAppliedCreditCents(booking.id, db);
  return {
    dueCents: bookingAmountOwedCents({
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment?.changeFeeCents ?? null,
      appliedCreditCents,
    }),
    appliedCreditCents,
  };
}
