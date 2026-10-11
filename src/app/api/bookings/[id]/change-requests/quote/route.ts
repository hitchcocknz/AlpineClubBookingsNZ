import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { bookingOwner } from "@/lib/booking-owner";
import { bookingManagementAuthorizationRole } from "@/lib/admin-permissions";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { deletedBookingRefusalResponse } from "@/lib/deleted-booking-refusal";
import {
  addedGuestNightsRefusal,
  changeRequestAddGuestSchema,
} from "@/lib/booking-change-request-guests";
import { estimateChangeRequestAddedGuests } from "@/lib/booking-change-request-estimate";

/**
 * #4030 Part A: the price estimate an in-progress stay's change-request card
 * shows for the guests the member is asking to add, before they send it.
 *
 * Side-effect free: nothing is written and no provider is contacted. Authorised
 * exactly as the request itself is (the booking's owner, or a Booking Officer).
 * Member guests are listed but never priced here — see
 * `booking-change-request-estimate.ts` for why that is a privacy boundary, not a
 * gap.
 */
const estimateSchema = z.object({
  addGuests: z.array(changeRequestAddGuestSchema).min(1).max(200),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) return inactiveResponse;
  const isAdmin = bookingManagementAuthorizationRole(session.user) === "ADMIN";

  const { id: bookingId } = await params;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      memberId: true,
      deletedAt: true,
      checkIn: true,
      checkOut: true,
      lodgeId: true,
      guests: {
        select: {
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          isMember: true,
          rateMembershipTypeId: true,
          nights: { select: { stayDate: true } },
        },
      },
    },
  });
  if (!booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }
  if (bookingOwner(booking).memberId !== session.user.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // After the 403, as on the request's own GET (`INV-ADDPAY-034`).
  if (booking.deletedAt) {
    return deletedBookingRefusalResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = estimateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const refusal = addedGuestNightsRefusal(parsed.data.addGuests, {
    checkIn: calendarDateOfDateOnlyInstant(booking.checkIn),
    checkOut: calendarDateOfDateOnlyInstant(booking.checkOut),
  });
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: 400 });
  }

  const estimate = await estimateChangeRequestAddedGuests(booking, parsed.data.addGuests);
  return NextResponse.json({ estimate });
}
