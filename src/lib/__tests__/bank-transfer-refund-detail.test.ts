import { describe, expect, it, vi } from "vitest";

import { bankTransferRefundDetailCents } from "@/lib/bank-transfer-refund-detail";

/**
 * #4290 (`INV-ADDPAY-043`): the #4162 floor's detail is a bank-transfer
 * payment's charge rows' refunded detail plus a group joiner's live settlement
 * refund line. The real writers are proved on PostgreSQL in
 * `bt-joiner-refund-detail.realdb.test.ts`; this pins the arithmetic.
 */
type Line = { id: string; reversesLineId: string | null; sign: 1 | -1; unitCents: number; quantity: number };

function store(input: { chargeRowsCents: number | null; bookingId?: string | null; lines?: Line[] }) {
  const findMany = vi.fn(async () =>
    (input.lines ?? []).map((line) => ({
      postingKey: null,
      kind: "BANK_REFUND",
      anchorKind: "GROUP_SETTLEMENT",
      anchorId: "settlement-1",
      settlementMethod: "INTERNET_BANKING",
      narration: "",
      ...line,
    })),
  );
  return {
    findMany,
    db: {
      paymentTransaction: { aggregate: vi.fn(async () => ({ _sum: { refundedAmountCents: input.chargeRowsCents } })) },
      payment: { findUnique: vi.fn(async () => (input.bookingId === null ? null : { bookingId: input.bookingId ?? "booking-1" })) },
      bookingLedgerLine: { findMany },
    } as never,
  };
}

const refundLine = (id: string, cents: number, reversesLineId: string | null = null): Line => ({
  id,
  reversesLineId,
  // A refund is a credit to the member (negative); its reversal is the opposite.
  sign: reversesLineId ? 1 : -1,
  unitCents: cents,
  quantity: 1,
});

describe("bankTransferRefundDetailCents (#4290)", () => {
  it("is the charge rows' refunded detail when the payment holds no settlement refund line", async () => {
    const { db } = store({ chargeRowsCents: 3_000 });
    expect(await bankTransferRefundDetailCents(db, "payment-1")).toBe(3_000);
  });

  it("MUTATION (joiner line): adds a group joiner's live settlement refund line, read on the payment's booking by kind and anchor", async () => {
    const { db, findMany } = store({ chargeRowsCents: null, lines: [refundLine("line-1", 2_250)] });
    expect(await bankTransferRefundDetailCents(db, "payment-1")).toBe(2_250);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: "booking-1", kind: "BANK_REFUND", anchorKind: "GROUP_SETTLEMENT" } }),
    );
  });

  it("MUTATION (netting): counts nothing for a reversed settlement refund line", async () => {
    const { db } = store({ chargeRowsCents: 500, lines: [refundLine("line-1", 2_250), refundLine("line-2", 2_250, "line-1")] });
    expect(await bankTransferRefundDetailCents(db, "payment-1")).toBe(500);
  });

  it("is the charge rows' detail alone, never negative, when the payment cannot be read", async () => {
    expect(await bankTransferRefundDetailCents(store({ chargeRowsCents: 700, bookingId: null }).db, "payment-1")).toBe(700);
    expect(await bankTransferRefundDetailCents(store({ chargeRowsCents: -5, bookingId: null }).db, "payment-1")).toBe(0);
  });
});
