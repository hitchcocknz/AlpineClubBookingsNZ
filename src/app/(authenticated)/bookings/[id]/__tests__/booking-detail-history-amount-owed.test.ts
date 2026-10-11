import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEventType } from "@prisma/client";

/**
 * #3991 (`INV-PAY-119`): the booking page's history narrative quotes what the
 * pay steps charge — the price plus a change fee recorded on the payment, less
 * the account credit applied to the booking — read from the one home,
 * `bookingAmountOwedCents`, with the credit from the ledger
 * (`deriveBookingAppliedCreditCents`), the same authority the card intent and
 * the payment-link page read. Before this the feed handed the narrative the
 * bare price, so a booking owing a fee or holding credit was quoted the wrong
 * figure.
 *
 * The REAL narrative resolver and the REAL credit derivation run here; only the
 * database and the timeline builder are stubbed. So a feed that drops the fee,
 * drops the credit, reads credit from anywhere but the ledger, or hands over
 * the bare price fails on the sentence the member reads.
 */

const mocks = vi.hoisted(() => ({
  memberCreditAggregate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    bookingEvent: { findMany: vi.fn().mockResolvedValue([]) },
    memberCredit: { aggregate: mocks.memberCreditAggregate },
  },
}));
vi.mock("@/lib/booking-history", () => ({
  buildBookingHistoryItems: vi.fn().mockReturnValue([]),
}));
vi.mock("@/lib/booking-financial-review-visibility", () => ({
  bookingHasOpenFinancialReview: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/rate-membership-label", () => ({
  loadRateMembershipLabelResolver: vi.fn(),
}));

import { loadBookingDetailHistory } from "../_lib/booking-detail-history";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { bookingAppliedCreditWhere } from "@/lib/member-credit-booking-rows";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

function bookingWith(payment: { changeFeeCents: number | null; creditAppliedCents?: number } | null) {
  return {
    id: "booking-1",
    status: "PAYMENT_PENDING",
    finalPriceCents: 20000,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    memberId: "member-1",
    member: { id: "member-1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.org" },
    organisationId: null,
    organisation: null,
    adminReviewStatus: null,
    adminReviewNotes: null,
    adminReviewReason: null,
    payment: payment
      ? {
          status: "PENDING",
          amountCents: 0,
          refundedAmountCents: 0,
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
          transactions: [],
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          creditAppliedCents: payment.creditAppliedCents ?? 0,
          changeFeeCents: payment.changeFeeCents,
        }
      : null,
    modifications: [],
    refundRequests: [],
    moneyReconciliation: null,
  } as never;
}

/** The ledger's `|Σ BOOKING_APPLIED|`, as the aggregate returns it (negative rows). */
function ledgerCredit(appliedCents: number) {
  mocks.memberCreditAggregate.mockResolvedValue({
    _sum: { amountCents: appliedCents === 0 ? null : -appliedCents },
  });
}

async function narrativeFor(booking: never) {
  const { bookingNarrative } = await loadBookingDetailHistory({
    booking,
    club: CLUB,
    viewer: { canSeeAdminTools: false } as never,
    format: CLUB_FORMAT_TEST,
  });
  return bookingNarrative;
}

beforeEach(() => {
  vi.clearAllMocks();
  ledgerCredit(0);
});

describe("booking page history narrative quotes the amount owed (#3991, INV-PAY-119)", () => {
  it("adds a change fee recorded on the payment to the price", async () => {
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("payable");
    // 200.00 + 25.00
    expect(narrative.message).toContain("$225.00 is due");
  });

  it("takes off the credit applied in the ledger, after adding the fee", async () => {
    ledgerCredit(5000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    // 200.00 + 25.00 - 50.00
    expect(narrative.message).toContain("$175.00 is due");
    expect(mocks.memberCreditAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: bookingAppliedCreditWhere("booking-1") }),
    );
  });

  it("reads credit from the ledger, the pay steps' authority, not the payment row's column", async () => {
    // The column says 90.00; the ledger, which the card intent charges against, says 50.00.
    ledgerCredit(5000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: null, creditAppliedCents: 9000 }));
    expect(narrative.message).toContain("$150.00 is due");
  });

  it("says there is nothing to pay, naming the credit, when the credit covers price and fee", async () => {
    ledgerCredit(22500);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("nothing_to_pay");
    expect(narrative.headline).toBe("Nothing to pay");
    expect(narrative.message).toContain("the account credit applied to it covers what it owes");
    expect(narrative.message).not.toMatch(/\$\d/);
  });

  it("still asks for the fee when credit covers only the price", async () => {
    ledgerCredit(20000);
    const narrative = await narrativeFor(bookingWith({ changeFeeCents: 2500 }));
    expect(narrative.state).toBe("payable");
    expect(narrative.message).toContain("$25.00 is due");
  });

  it("CONTROL: a plain booking with no payment row and no credit is quoted its price, as before", async () => {
    const narrative = await narrativeFor(bookingWith(null));
    expect(narrative.state).toBe("payable");
    expect(narrative.message).toContain("$200.00 is due");
  });

  it("CONTROL: a paid booking's narrative is untouched by what is owed", async () => {
    ledgerCredit(5000);
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.bookingEvent.findMany).mockResolvedValueOnce([
      {
        id: "ev-paid",
        type: BookingEventType.MEMBER_PAID,
        occurredAt: new Date("2026-07-02T00:00:00.000Z"),
        amountCents: 22500,
        reason: null,
        snapshot: null,
      },
    ] as never);
    const narrative = await narrativeFor({ ...(bookingWith({ changeFeeCents: 2500 }) as object), status: "PAID" } as never);
    expect(narrative.state).toBe("paid");
    expect(narrative.message).toContain("$225.00");
  });
});
