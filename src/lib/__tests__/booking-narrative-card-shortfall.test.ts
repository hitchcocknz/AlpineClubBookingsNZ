import { describe, expect, it } from "vitest";
import { BookingEventType } from "@prisma/client";

import { resolveBookingNarrative, type NarrativeBooking, type NarrativeEvent } from "@/lib/booking-narrative";
import type { CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4097 (`INV-PAY-129`): the booking page's narrative for a card cancel whose
 * card refund plan carried less than the refund due. The CANCELLED snapshot
 * freezes the card's part and the two parts beside it; the page hands over the
 * tasks' live status, and the sentence follows each part: owed, refunded by
 * bank transfer, or checked and closed.
 *
 * MUTATION PROOF. Drop the `cardShortfall` branch and every case below reads
 * "$100.00 was refunded"; read the bank part's status for the check part (or
 * the other way round) and the mixed case fails.
 */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

const BOOKING: NarrativeBooking = {
  status: "CANCELLED",
  finalPriceCents: 12000,
  amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 },
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
  firstName: "Sam",
  adminReviewStatus: null,
  adminReviewNotes: null,
  adminReviewReason: null,
};

function event(type: BookingEventType, occurredAt: string, extra: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return { type, occurredAt: new Date(occurredAt), amountCents: null, reason: null, snapshot: null, ...extra };
}

function narrate(parts: { cardCents: number; bankCents: number; checkCents: number }, statuses: CardShortfallTaskStatuses) {
  const events = [
    event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
    event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: {
        policySummary: "Cancelled 30 day(s) before check-in: 100% card refund under the policy in effect at the time.",
        refundMethod: "card",
        refundPercentage: 100,
        paidAmountCents: 12000,
        settledAmountCents: 10000,
        retainedAmountCents: 2000,
        changeFeeCents: 0,
        cardShortfall: parts,
      },
    }),
    ...(parts.cardCents > 0
      ? [event(BookingEventType.REFUNDED, "2026-05-05T01:00:00.000Z", { amountCents: parts.cardCents })]
      : []),
  ];
  return resolveBookingNarrative({ club: CLUB, booking: BOOKING, events, cardShortfallStatuses: statuses }, CLUB_FORMAT_TEST).message;
}

const LEAD = "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, ";

describe("#4097: the booking page names each part of a card refund shortfall and where it stands", () => {
  it.each([
    ["owed", "OPEN", "$40.00 is being refunded to you by bank transfer"],
    ["paid back", "COMPLETED", "$40.00 was refunded to you by bank transfer"],
    ["dismissed", "DISMISSED", "the club checked the $40.00 it was to refund by bank transfer and closed it"],
  ] as const)("the bank-transfer part, %s", (_label, status, clause) => {
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: status })).toBe(
      `${LEAD}$60.00 was refunded to your card on 5 May 2026, ${clause} and $20.00 was retained. No further payment is required.`,
    );
  });

  it.each([
    ["owed", "OPEN", "the club will be in touch about the remaining $40.00"],
    ["paid back", "COMPLETED", "$40.00 was refunded to you by bank transfer"],
    ["checked", "DISMISSED", "the club checked the remaining $40.00 and closed it"],
  ] as const)("the part to check, %s", (_label, status, clause) => {
    expect(narrate({ cardCents: 6000, bankCents: 0, checkCents: 4000 }, { check: status })).toBe(
      `${LEAD}$60.00 was refunded to your card on 5 May 2026, ${clause} and $20.00 was retained. No further payment is required.`,
    );
  });

  it("both parts follow their own task, and a zero plan names no card refund", () => {
    expect(narrate({ cardCents: 0, bankCents: 3000, checkCents: 7000 }, { bank: "COMPLETED", check: "OPEN" })).toBe(
      `${LEAD}$30.00 was refunded to you by bank transfer, the club will be in touch about the remaining $70.00 and $20.00 was retained. No further payment is required.`,
    );
  });

  it("with no status handed over, each part reads as still owed", () => {
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, {})).toContain("$40.00 is being refunded to you by bank transfer");
  });
});
