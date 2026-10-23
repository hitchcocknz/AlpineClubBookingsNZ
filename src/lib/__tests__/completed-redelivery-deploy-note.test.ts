import { BookingStatus, PaymentRecoveryOperationType, PaymentSource, PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { buildDuplicateCaptureRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import { CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { SUPERSEDED_INTENT_OPERATION_TYPES } from "@/lib/superseded-intent-ownership";
import { completedRedeliveryDeployQuery } from "./support/completed-redelivery-deploy-query";

/**
 * #4285 (`INV-SSOT`, `INV-PAY-043`): the UPGRADING deploy query, which lists
 * completed bookings that may hold a second card payment nobody refunded,
 * spells by hand what the code defines once - the booking status, a card
 * capture's kind and source, the captured statuses, the duplicate-capture
 * refund's key and the superseded refund's type - because an operator runs it
 * in psql. This pins each literal to the code, so a drift fails here rather
 * than leaving a query that quietly lists nothing. The real-PostgreSQL proof
 * (`completed-redelivery.realdb.test.ts`) runs the same query.
 */
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!);
const list = (text: string) => text.split(", ").map((item) => item.slice(1, -1));

describe("the #4285 deploy query matches the code's one definition", () => {
  const sql = completedRedeliveryDeployQuery();

  it("reads completed bookings' card captures by the code's status, kind and source", () => {
    expect(all(sql, /b\.status = '([^']*)'/g)).toEqual([BookingStatus.COMPLETED]);
    expect(all(sql, /t\.kind = '([^']*)'/g)).toEqual([PaymentTransactionKind.PRIMARY]);
    expect(all(sql, /t\.source = '([^']*)'/g)).toEqual([PaymentSource.STRIPE]);
  });

  it("counts every row that may hold money, and needs one the app recorded as captured", () => {
    const [candidates, captured] = all(sql, /t\.status IN \(([^)]*)\)/g).map(list);
    expect(new Set(captured)).toEqual(new Set(CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST));
    // A refused success never wrote its row, so it still reads PENDING or PROCESSING.
    expect(new Set(candidates)).toEqual(new Set([...CAPTURED_NOT_FULLY_REFUNDED_TRANSACTION_STATUS_LIST, PaymentStatus.PENDING, PaymentStatus.PROCESSING]));
    // Only FAILED (a cancelled or declined intent) and fully REFUNDED rows are left out.
    expect(Object.values(PaymentStatus).filter((status) => !candidates!.includes(status)).sort()).toEqual([PaymentStatus.FAILED, PaymentStatus.REFUNDED].sort());
  });

  it("leaves out a capture a duplicate-capture refund owns, by the key the refund is enqueued under", () => {
    const [shape] = all(sql, /o\."idempotencyKey" = ([^\n]*)/g);
    const rendered = shape!
      .replace(/^'([^']*)' \|\| b\.id \|\| '([^']*)' \|\| t\."stripePaymentIntentId"$/, (_all, head: string, mid: string) => `${head}BOOKING${mid}PI`);
    expect(rendered).toBe(buildDuplicateCaptureRefundRecoveryIdempotencyKey("BOOKING", "PI"));
  });

  it("leaves out a capture the superseded-payment refund is sending back", () => {
    const [type] = all(sql, /s\.type = '([^']*)'/g);
    expect(type).toBe(PaymentRecoveryOperationType.REFUND_SUPERSEDED_PAYMENT);
    expect(SUPERSEDED_INTENT_OPERATION_TYPES).toContain(type);
  });
});
