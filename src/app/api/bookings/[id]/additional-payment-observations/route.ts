import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { readBookingOutstandingAction } from "@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding";

/** One authenticated, cursor-bound supplementary invoice read; never a collection writer. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const cursor = request.nextUrl.searchParams.get("cursor");
  if (!cursor || cursor.length > 2_000) return NextResponse.json({ error: "Invalid continuation" }, { status: 400 });
  const result = await readBookingOutstandingAction(id, guard.session.user.id, cursor).catch(() => ({ view: { kind: "hidden" } as const }));
  return NextResponse.json(result.view, { headers: { "Cache-Control": "private, no-store" } });
}
