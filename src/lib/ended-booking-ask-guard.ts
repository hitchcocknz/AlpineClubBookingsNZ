/**
 * #4316 (`INV-ADDPAY-044`): AN EDIT'S AFTER-COMMIT MINT NEVER LEAVES A LIVE ASK
 * ON A BOOKING THAT HAS ENDED.
 *
 * The edit doors decide to ask the card under `lock(1)`, but
 * `createModificationAdditionalPaymentIntent` creates the Stripe intent after
 * their commit, so a cancel can land in between - and so can it before the
 * recovery runner's replay of a failed mint
 * (`processCreateAdditionalPaymentIntentOperation`), which runs both guards too. The paid cancel's claim
 * retires only the intent it reads on the `Payment` mirror. The minter
 * therefore re-reads the booking twice, against the statuses that retire every
 * ask on it (`ADDITIONAL_ASK_RETIRED_BOOKING_STATUSES`, `INV-ADDPAY-023`):
 * before the provider call (`bookingEndedBeforeAskMint`) and after its row
 * write (`retireAskOnEndedBooking`). Both are plain reads: the order the second
 * one needs comes from the `Payment` row lock the row write takes.
 */
import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import {
  cancelSupersededAdditionalIntentsNow,
  failOutstandingAdditionalAskInClaim,
} from "@/lib/booking-payment-cleanup";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

async function bookingHasEnded(bookingId: string): Promise<boolean> {
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
  return isAdditionalAskRetiredBookingStatus(booking?.status);
}

/**
 * Before the provider call: has the booking ended (CANCELLED or BUMPED) since
 * its edit committed? Then it is asked nothing and owes nothing - no intent, no
 * row, no recovery. A re-issue's recovery, written with the edit, is closed by
 * its runner, which skips a cancelled booking. A failed read answers no and the
 * mint goes ahead; the check after the row write still stands.
 */
export async function bookingEndedBeforeAskMint(
  bookingId: string,
  bookingModificationId: string | null,
): Promise<boolean> {
  const ended = await bookingHasEnded(bookingId).catch((err: unknown) => {
    logger.error({ err, bookingId }, "Could not re-read the booking before minting its additional ask (#4316)");
    return false;
  });
  if (ended) {
    logger.info(
      { bookingId, bookingModificationId },
      "The booking ended after its edit committed; no additional ask is minted (#4316)",
    );
  }
  return ended;
}

/**
 * After the row write: THE OTHER HALF OF THE RACE. A cancel that committed after
 * the check above, but before this ask's row was written, read a `Payment`
 * mirror with no such intent on it, so it left this one live at Stripe on a
 * cancelled booking.
 *
 * The two writers cannot both miss: the row write takes the `Payment` row lock,
 * as the paid cancel's claim does before it reads the mirror. A cancel that
 * held it first committed before the row was written, so this read sees it; one
 * that took it after reads this intent on the mirror and retires it itself.
 * When the booking has ended, the ask is retired here as that claim retires one
 * - the same routine under the same row lock
 * (`failOutstandingAdditionalAskInClaim`): the mirror and the row FAILED and a
 * durable cancellation queued, then run now. One the cancel already retired is
 * outstanding no longer and is left to it.
 *
 * Returns whether the booking has ended; the minter then offers no secret and
 * returns no intent id. A failed status read answers no, as the code did before
 * #4316; a failed retirement is logged with the intent and still answers yes.
 */
export async function retireAskOnEndedBooking({
  format,
  bookingId,
  paymentId,
  paymentIntentId,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
}): Promise<boolean> {
  const ended = await bookingHasEnded(bookingId).catch((err: unknown) => {
    logger.error(
      { err, bookingId, paymentIntentId },
      "Could not re-read the booking after writing its additional ask; it is offered as live (#4316)",
    );
    return false;
  });
  if (!ended) return false;
  try {
    const queued = await prisma.$transaction(async (tx) => {
      await lockPaymentForRefundedTotal(tx, paymentId);
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        select: { id: true, additionalPaymentIntentId: true, additionalPaymentStatus: true },
      });
      return payment ? failOutstandingAdditionalAskInClaim(tx, { bookingId, payment }) : null;
    });
    if (queued) await cancelSupersededAdditionalIntentsNow({ format, bookingId, paymentId, queued: [queued] });
    logger.warn(
      { bookingId, paymentId, paymentIntentId, retiredHere: queued !== null },
      "The booking ended while its edit's additional ask was minted; the ask is retired, not offered (#4316)",
    );
  } catch (err) {
    logger.error(
      { err, bookingId, paymentId, paymentIntentId },
      "Could not retire an additional ask minted on a booking that has ended; the intent may stay live at Stripe (#4316)",
    );
  }
  return true;
}
