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
 * it and is absent before a payment row exists. It is the one read for the
 * booking page, the payment-link page, the payment link's card intent and the
 * member's card intent (`create-payment-intent`, both reads, the second under
 * its transaction): what those quote and what they charge come from here.
 *
 * NOT YET EVERY READER. These still call `bookingAmountOwedCents` with credit
 * they read or are handed themselves, and are known (#3991, to be raised on
 * their own): `confirm-payment/route.ts`, `switch-to-internet-banking/route.ts`,
 * `stripe-webhook-service.ts`, `manual-booking-payment-state.ts`,
 * `payment-reconciliation.ts`, `booking-modify-settlement.ts`,
 * `booking-date-modification-service.ts`, `booking-credit-election.ts`,
 * `edit-financial-review-account-credit.ts` and
 * `policies/booking-route-decisions.ts`. `amount-owed-one-home.test.ts` pins
 * that list, so a new composer is a deliberate addition.
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
