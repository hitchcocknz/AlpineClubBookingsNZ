import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #3924 round 11 (`INV-PAY-110`, `INV-PAY-122`): TWO VERDICTS OF ONE RECEIPT.
 * A late capture's receipt row an officer resolved by hand is the officer's
 * record for every card-refund path - the refund note's eligible cash, the
 * card-note gap, the late-capture refund repair - exactly as before #3924, so
 * none of them raises or counts a card note for it. Only a refund closed as
 * paid another way reads the wider verdict, where a row resolved after the app
 * sent it, or a change linked in Xero, is the app's own invoice and the close's
 * note follows it. The real reader runs here over an in-memory store; the
 * callers around it are real too, with only their other reads stubbed.
 */
const state = vi.hoisted(() => ({
  keptResolved: [] as Array<{ xeroObjectId: string | null }>,
  change: [] as Array<{
    status: string;
    xeroObjectId: string | null;
    manuallyResolvedAt: Date | null;
    localModel: string;
    localId: string;
    requestPayload: Record<string, unknown>;
  }>,
  changeLink: null as { xeroObjectId: string } | null,
  note: vi.fn(),
}));

const RESOLVED_AT = new Date("2026-06-20T00:00:00.000Z");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    manualRefundTask: {
      findUnique: async () => ({ id: "task_late" }),
      findMany: async () => [{ id: "task_late", lateCaptureApprovalIntentId: "pi_late", reason: null }],
    },
    xeroObjectLink: {
      findFirst: async ({ where }: { where: { role?: string } }) =>
        where.role === "SUPPLEMENTARY_INVOICE" ? state.changeLink : null,
    },
    xeroSyncOperation: {
      findMany: async ({ where }: { where: { queueType?: string } }) =>
        where.queueType === "KEPT_LATE_CAPTURE_INVOICE" ? state.keptResolved : state.change,
    },
    paymentRefund: {
      findMany: async () => [
        { stripePaymentIntentId: "pi_ordinary", amountCents: 10000, status: "succeeded" },
        { stripePaymentIntentId: "pi_late", amountCents: 24000, status: "succeeded" },
      ],
    },
    booking: {
      findUnique: async () => ({
        memberId: "member_1",
        member: { firstName: "Ann", lastName: "Lee" },
        organisation: null,
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        deletedAt: null,
      }),
    },
    paymentTransaction: { findFirst: async () => ({ kind: "PRIMARY" }) },
  },
}));
vi.mock("@/lib/stripe-cash-refund-evidence", () => ({
  resolveStripeCashRefundEvidence: async () => ({ source: "provider-ledger", cashRefundCents: 34000 }),
}));
vi.mock("@/lib/xero-resolved-in-xero-fences", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-resolved-in-xero-fences")),
  readResolvedRefundCreditNoteCoverage: async () => ({ coveredCents: 0 }),
  sumRefundCreditNoteCoverageCents: async () => 0,
}));
vi.mock("@/lib/card-refund-paid-another-way-cash", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/card-refund-paid-another-way-cash")),
  readPaidAnotherWayUncoveredCents: async () => 0,
}));
vi.mock("@/lib/cancelled-booking-late-capture", () => ({
  recordAutomaticLateCaptureRefund: async () => ({ bookingDeleted: false, recorded: true, handCompletedAfterRefund: false }),
  announceAutomaticLateCaptureRefund: async () => undefined,
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({
  noteLateCaptureRefunds: (...a: unknown[]) => state.note(...a),
}));

import {
  hasXeroReceiptForLateCapture,
  readLateCaptureXeroReceipt,
  readPaidAnotherWayLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { readRefundCreditNoteGap } from "@/lib/xero-admin-health";
import { recordAndNoteRepairedLateCaptureRefunds } from "@/lib/late-capture-repair-refund-record";

const PAYMENT = { id: "payment_1", bookingId: "booking_1", refundedAmountCents: 34000 };

/** A change's invoice the app sent, whose payment failed (PARTIAL), then resolved by hand. */
const resolvedPartialChange = {
  status: "PARTIAL",
  xeroObjectId: "inv_change",
  manuallyResolvedAt: RESOLVED_AT,
  localModel: "BookingModification",
  localId: "mod_1",
  requestPayload: { paymentIntentId: "pi_late" },
};

/** Each shape of a resolved row the round-10 widening reads as the app's receipt. */
const RESOLVED_ROWS: Array<[string, () => void, string]> = [
  ["the kept receipt's PARTIAL row, resolved after the app sent it", () => {
    state.keptResolved = [{ xeroObjectId: "inv_kept" }];
  }, "inv_kept"],
  ["a change's PARTIAL row, resolved after the app sent it", () => {
    state.change = [resolvedPartialChange];
  }, "inv_change"],
  ["a change's row resolved by hand while its change is linked in Xero", () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null }];
    state.changeLink = { xeroObjectId: "inv_linked" };
  }, "inv_linked"],
];

beforeEach(() => {
  state.keptResolved = [];
  state.change = [];
  state.changeLink = null;
  state.note.mockReset();
  state.note.mockResolvedValue("queued");
});

describe.each(RESOLVED_ROWS)("round 11: %s", (_label, arrange, invoiceId) => {
  beforeEach(arrange);

  it("MUTATION: is resolved by hand for every card-refund path, as before #3924", async () => {
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "resolved-by-hand" });
    await expect(hasXeroReceiptForLateCapture("pi_late")).resolves.toBe(false);
  });

  it("MUTATION: is recorded against that invoice only for a refund closed as paid another way", async () => {
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({ kind: "recorded", invoiceId });
  });

  it("leaves the capture's refund out of the cash a refund note may answer", async () => {
    await expect(resolveRefundNoteEligibleCash(PAYMENT)).resolves.toMatchObject({
      lateCaptureExcludedCents: 24000,
      eligibleCashCents: 10000,
    });
  });

  it("leaves it out of the card-note gap the nightly self-heal fills", async () => {
    await expect(readRefundCreditNoteGap(PAYMENT)).resolves.toMatchObject({
      cashRefundCents: 10000,
      uncoveredCents: 10000,
    });
  });

  it("is reported by hand by the late-capture refund repair, and never noted", async () => {
    const outcome = await recordAndNoteRepairedLateCaptureRefunds({
      bookingId: "booking_1",
      paymentId: "payment_1",
      refunds: [{ paymentIntentId: "pi_late", amountCents: 24000 }],
      format: CLUB_FORMAT_TEST,
    });
    expect(outcome.byHand).toEqual(["pi_late"]);
    expect(outcome.noted).toEqual([]);
    expect(state.note).not.toHaveBeenCalled();
  });
});

describe("round 11: a change linked in Xero whose row FAILED after the link", () => {
  it("keeps the card-refund verdict (no id, failed) and names the link only when paid another way", async () => {
    state.change = [{ ...resolvedPartialChange, status: "FAILED", xeroObjectId: null, manuallyResolvedAt: null }];
    state.changeLink = { xeroObjectId: "inv_linked" };
    await expect(readLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: null,
      invoiceFailed: true,
    });
    await expect(readPaidAnotherWayLateCaptureXeroReceipt("pi_late")).resolves.toEqual({
      kind: "recorded",
      invoiceId: "inv_linked",
    });
  });
});
