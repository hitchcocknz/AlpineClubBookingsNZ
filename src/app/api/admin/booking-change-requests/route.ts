import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { z } from "zod";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { isFinishedStay } from "@/lib/booking-edit-policy";
import { storedRequestNamesNoChange } from "@/lib/booking-change-request-stored";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { loadMemberGuestFindGate } from "@/lib/member-guest-find-service";

const querySchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "ALL"]).optional().default("REQUESTED"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  // #2524: POLICY_EXCEPTION rows share this table but are decided through the
  // booking-policy exception workflow (#2525) and surface only in the unified
  // queue. Scope this legacy locked-period queue to LOCKED_PERIOD so those rows
  // never inflate the list or its count — the symmetric exclusion to the
  // unified queue's kind:"POLICY_EXCEPTION" filter. Both findMany and count
  // reuse this `where`, so the guard applies to the total as well as the page.
  const where: Prisma.BookingChangeRequestWhereInput =
    status === "ALL"
      ? { kind: "LOCKED_PERIOD" }
      : { kind: "LOCKED_PERIOD", status };
  const [requests, total] = await Promise.all([
    prisma.bookingChangeRequest.findMany({
      where,
      include: {
        requestedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        reviewedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        linkedModification: {
          select: {
            id: true,
            createdAt: true,
            modificationType: true,
            priceDiffCents: true,
            changeFeeCents: true,
          },
        },
        booking: {
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            status: true,
            finalPriceCents: true,
            member: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
            // #3369: the owner may be an Organisation; bookingOwner() reads both.
            organisation: { select: { name: true, email: true } },
            // #4030: the member ids already on the booking, and nothing else
            // about its guests, so the officer's member finder disables them.
            guests: { where: { memberId: { not: null } }, select: { memberId: true } },
            payment: {
              select: {
                id: true,
                amountCents: true,
                refundedAmountCents: true,
                status: true,
                xeroInvoiceId: true,
                xeroInvoiceNumber: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    prisma.bookingChangeRequest.count({ where }),
  ]);

  // #3750: whether approving a request EXECUTES it — its booking's stay has
  // finished — answered here from the same `isFinishedStay` the decision route
  // asks, so the panel's wording and the route's behaviour cannot disagree.
  const today = await clubTodayDateOnlyInstant();
  const data = requests.map((request) => {
    const executesOnApproval = isFinishedStay(request.booking, today);
    return {
      ...request,
      executesOnApproval,
      // #4030 Part B: a pending request on a finished stay that names no change
      // (a member's free-text note) — the officer may enter the guests it
      // describes. Asked through the executor's own mapping, so the card never
      // offers an entry the approval would refuse.
      acceptsOfficerGuests:
        executesOnApproval &&
        request.status === "REQUESTED" &&
        storedRequestNamesNoChange(request.requestedChanges, request.booking),
    };
  });

  // #4030 Part B: the officer's member-guest finder, when the club's module is
  // on — email lookup for any officer, name search only with the membership
  // directory, exactly the gates the admin finder route itself applies.
  const memberGuestFind = data.some((request) => request.acceptsOfficerGuests)
    ? (await loadMemberGuestFindGate({ requiresOpenSearch: false })).ok
      ? {
          openSearchEnabled: hasAdminAreaAccess(guard.session.user, {
            area: "membership",
            level: "view",
          }),
        }
      : null
    : null;

  return NextResponse.json({ data, page, pageSize, total, memberGuestFind });
}
