import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3956 round 3: the review queue tells the screen whether a zero ceiling on a
 * group joiner's appeal is only a wait for the group cancellation's own refund.
 */
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  organiserCardAppealCeilingFor: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      count: (...args: unknown[]) => mocks.count(...args),
    },
  },
}));
vi.mock("@/lib/organiser-child-refund", () => ({
  organiserCardAppealCeilingFor: (...args: unknown[]) => mocks.organiserCardAppealCeilingFor(...args),
}));

import { GET } from "@/app/api/admin/refund-requests/route";

function request(id: string, status = "PENDING") {
  return {
    id,
    status,
    booking: { id: `b-${id}`, payment: { id: `p-${id}`, source: "STRIPE" } },
  };
}

describe("GET /api/admin/refund-requests, organiser-card appeals (#3956)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true });
    mocks.count.mockResolvedValue(3);
  });

  it("flags an appeal waiting on the group cancellation's refund, rather than showing a bare zero ceiling", async () => {
    mocks.findMany.mockResolvedValue([request("waiting"), request("open"), request("plain"), request("done", "APPROVED")]);
    mocks.organiserCardAppealCeilingFor.mockImplementation(async (_db: unknown, booking: { id: string }) => {
      if (booking.id === "b-waiting") return { ceilingCents: 0, combinedRefundPending: true };
      if (booking.id === "b-open") return { ceilingCents: 4_000, combinedRefundPending: false };
      return null;
    });

    const response = await GET(new NextRequest("http://localhost/api/admin/refund-requests?status=ALL"));
    const { data } = (await response.json()) as { data: Array<{ id: string; booking: Record<string, unknown> }> };
    const byId = Object.fromEntries(data.map((row) => [row.id, row.booking]));

    expect(byId.waiting).toMatchObject({ organiserCardMaxRefundableCents: 0, organiserCardCombinedRefundPending: true });
    expect(byId.open).toMatchObject({ organiserCardMaxRefundableCents: 4_000, organiserCardCombinedRefundPending: false });
    expect(byId.plain).not.toHaveProperty("organiserCardMaxRefundableCents");
    // A decided request is not re-read: no ceiling is offered on it.
    expect(byId.done).not.toHaveProperty("organiserCardCombinedRefundPending");
    expect(mocks.organiserCardAppealCeilingFor).toHaveBeenCalledTimes(3);
  });
});
