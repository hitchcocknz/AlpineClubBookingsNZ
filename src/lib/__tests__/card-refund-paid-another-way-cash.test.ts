import { describe, expect, it, vi } from "vitest";

/**
 * #4159 review round 2 (F1, `INV-PAY-134`): a capacity race's part to check
 * whose record keeps a card note's cover is NOTED bank cash, with or without a
 * note row of its own - so the legacy-mirror cash keeps it, and the card note
 * already in Xero answers it rather than reading as over-coverage.
 */
vi.mock("@/lib/late-capture-paid-another-way", () => ({ paidAnotherWayCloseReceiptRecorded: vi.fn() }));
vi.mock("@/lib/xero-resolved-in-xero-fences", () => ({ sumRefundCreditNoteCoverageOfRowsCents: vi.fn(async () => 0) }));

import { readPaidAnotherWayCash, readPaidAnotherWayCloseShare } from "@/lib/card-refund-paid-another-way-cash";

const RACE_KEY = "cancel-card-shortfall:booking-1:capacity-race:pi_race:check";

function db(task: { reviewContext: unknown }, noteRows: number) {
  const row = { id: "task-race", kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: RACE_KEY, amountCents: 20_000, ...task };
  return {
    manualRefundTask: { findMany: vi.fn(async () => [row]), findFirst: vi.fn(async () => row) },
    xeroSyncOperation: { count: vi.fn(async () => noteRows) },
    xeroObjectLink: {},
    paymentRecoveryOperation: {},
  } as never;
}

describe("a capacity race's part to check, as the note pipeline reads its bank cash (#4159 F1)", () => {
  it("MUTATION: covered by a card note and with no note row of its own, it is noted - and its own note owes nothing", async () => {
    const store = db({ reviewContext: { paidAnotherWayCardNoteCover: 20_000 } }, 0);
    await expect(readPaidAnotherWayCash(store, "payment-1")).resolves.toEqual({ notedCents: 20_000, unnotedCents: 0, awaitingReceiptCents: 0 });
    await expect(readPaidAnotherWayCloseShare(store, "payment-1", "task-race")).resolves.toMatchObject({ cardNoteCoversCents: 20_000, uncoveredCents: 0 });
  });

  it("CONTROL: with no cover and no note row (a booking with no invoice), it stays un-noted", async () => {
    await expect(readPaidAnotherWayCash(db({ reviewContext: null }, 0), "payment-1")).resolves.toEqual({ notedCents: 0, unnotedCents: 20_000, awaitingReceiptCents: 0 });
  });
});
