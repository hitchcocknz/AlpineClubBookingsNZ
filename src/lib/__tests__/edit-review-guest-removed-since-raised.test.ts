import { describe, expect, it } from "vitest";

import {
  editFinancialReviewGuestsRemovedSinceRaised,
  parseEditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";
import { toOpenManualRefundTaskPayload } from "@/lib/manual-refund-task-queue-payload";

/**
 * #4317 (owner decision on #4302, after review round 1): AN OPEN REVIEW WHOSE
 * GUEST WAS REMOVED AFTER IT WAS RAISED WARNS THE OFFICER.
 *
 * A priced removal credits the guest's whole stored total, which still holds
 * the nights the pre-#4317 review was raised over, so settling the review would
 * credit them a second time. Wave B's clean-up closes such a review with no
 * money moved; until then the settle screen says so. The guest that a parked
 * REMOVAL itself took off - deleted in the transaction that raised the review -
 * is not one of these: nothing was credited for it.
 */

const NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03"];
const evidence = (total: number, prices: Array<number | null>) => ({
  guestTotalCents: total,
  nightPrices: NIGHTS.map((date, index) => ({ date, priceCents: prices[index] ?? null })),
});

/** A shortening of A that parked, beside B, which the edit did not touch. */
const SHORTENING = {
  version: 1,
  occurrence: {
    bookingId: "booking-1",
    bookingGuestId: "guest-a",
    cause: "PARTIAL_STORED_NIGHT_PRICES",
    surrenderedNightDates: ["2026-08-03"],
    addedNightDates: [],
    storedEvidence: evidence(30_000, [10_000, null, 10_000]),
    otherStrands: [
      {
        bookingGuestId: "guest-b",
        cause: "NO_STORED_NIGHT_PRICES",
        surrenderedNightDates: [],
        addedNightDates: [],
        storedEvidence: { guestTotalCents: 20_000, nightPrices: [] },
      },
    ],
  },
  guestMemberId: null,
  bookingCheckIn: "2026-08-01",
  bookingCheckOut: "2026-08-04",
  bookingModificationId: "mod-1",
};

/** A parked removal of C: its departing guest left in the edit that raised it. */
const PARKED_REMOVAL = {
  ...SHORTENING,
  occurrence: {
    bookingId: "booking-1",
    bookingGuestId: "guest-c",
    cause: "INEXACT_STORED_NIGHT_PRICES",
    surrenderedNightDates: NIGHTS,
    addedNightDates: [],
    storedEvidence: evidence(30_000, [10_000, 10_000, 10_000]),
  },
};

const read = (raw: unknown) => {
  const parsed = parseEditFinancialReviewContext(JSON.parse(JSON.stringify(raw)));
  if (!parsed) throw new Error("fixture failed to parse");
  return parsed;
};

describe("editFinancialReviewGuestsRemovedSinceRaised", () => {
  it("finds nobody while every guest the review names is still on the booking", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-a", "guest-b"])),
    ).toEqual([]);
  });

  it("finds the shortened guest once a removal has taken them off", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-b"])),
    ).toEqual(["guest-a"]);
  });

  it("finds an untouched guest the review names, removed since", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(SHORTENING), new Set(["guest-a"])),
    ).toEqual(["guest-b"]);
  });

  it("does not count the guest a parked removal itself took off", () => {
    expect(
      editFinancialReviewGuestsRemovedSinceRaised(read(PARKED_REMOVAL), new Set(["guest-b"])),
    ).toEqual([]);
  });
});

describe("the queue payload's reviewGuestRemovedSinceRaised", () => {
  const row = {
    id: "task-1",
    bookingId: "booking-1",
    amountCents: null,
    raisedAmountCents: null,
    kind: "EDIT_FINANCIAL_REVIEW",
    paymentId: null,
    payment: null,
    lateCaptureApprovalIntentId: null,
    partPaymentReviewPaymentId: null,
    partPaymentReviewXeroPaidAt: null,
    partPaymentReviewXeroPaidCents: null,
    occurrenceKey: "edit-financial-review:v1:abc",
    reviewContext: SHORTENING,
    reason: "r",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    booking: {
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
      member: { firstName: "Ann", lastName: "Owner" },
      organisation: null,
      memberId: "ann",
      deletedAt: null,
      organiserSettled: false,
      parentBookingId: null,
      status: "CONFIRMED",
      payment: null,
      guests: [{ id: "guest-b" }],
    },
  };

  it("is true on an open review whose shortened guest has since been removed", () => {
    expect(toOpenManualRefundTaskPayload(row, null, []).reviewGuestRemovedSinceRaised).toBe(true);
  });

  it("is false while the guests are all still on the booking", () => {
    const stillThere = { ...row, booking: { ...row.booking, guests: [{ id: "guest-a" }, { id: "guest-b" }] } };
    expect(toOpenManualRefundTaskPayload(stillThere, null, []).reviewGuestRemovedSinceRaised).toBe(false);
  });

  it("is false where the booking's guests were not read, and on a hand-back", () => {
    const bookingWithoutGuests: Omit<typeof row.booking, "guests"> & { guests?: undefined } = {
      ...row.booking,
      guests: undefined,
    };
    expect(
      toOpenManualRefundTaskPayload({ ...row, booking: bookingWithoutGuests }, null, [])
        .reviewGuestRemovedSinceRaised,
    ).toBe(false);
    expect(
      toOpenManualRefundTaskPayload({ ...row, kind: "CANCELLED_BOOKING_HAND_BACK" }, null, [])
        .reviewGuestRemovedSinceRaised,
    ).toBe(false);
  });
});
