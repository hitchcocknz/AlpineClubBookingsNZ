import { prisma } from "@/lib/prisma";
import { refundAppealHandedBackCents } from "@/lib/edit-refund-hand-back";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";
import { organiserCardAppealCap } from "@/lib/organiser-child-refund";

/**
 * #3956 (`INV-PAY-123`): on a cancelled booking the group organiser paid for by
 * card, the most a refund appeal can ask for is what the organiser's combined
 * payment can still return (`organiserCardAppealCap`) - the figure the appeal
 * route and its approval cap at - not the booking's own payment row alone.
 * Null for any other booking, which keeps `refundAppealCeiling`.
 */
export async function loadOrganiserCardAppealCeiling(booking: {
  id: string;
  status: string;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: { id: string; source: string; status: string; amountCents: number; refundedAmountCents: number } | null;
}): Promise<number | null> {
  if (booking.status !== "CANCELLED" || !booking.payment || !paidByOrganiserCard(booking)) return null;
  const handedBackCents = await refundAppealHandedBackCents(prisma, { id: booking.payment.id, bookingId: booking.id });
  const cap = await organiserCardAppealCap(prisma, booking, booking.payment, handedBackCents);
  return cap?.maxRefundableCents ?? null;
}
