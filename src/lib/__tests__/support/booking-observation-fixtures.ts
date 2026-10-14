import type { EditFinancialReviewContext } from "@/lib/edit-financial-review-context";

export function observationReviewContext(bookingId: string, modificationId: string): EditFinancialReviewContext {
  return {
    version: 1, bookingModificationId: modificationId, guestMemberId: null,
    bookingCheckIn: "2026-06-01", bookingCheckOut: "2026-06-02",
    occurrence: { bookingId, bookingGuestId: "synthetic-guest", cause: "NO_STORED_NIGHT_PRICES",
      surrenderedNightDates: ["2026-06-01"], addedNightDates: [], storedEvidence: { guestTotalCents: null, nightPrices: [] } },
  };
}
