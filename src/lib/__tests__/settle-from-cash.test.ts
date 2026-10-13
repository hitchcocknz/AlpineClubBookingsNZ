import { describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  cashSettlementNoticeMessage,
  planInternetBankingCashSettlement,
  type CashSettlementTransaction,
} from "@/lib/xero-inbound/settle-from-cash";

/**
 * #3979 (`INV-PAY-124`): the one decision on whether a bank transfer's
 * settle records the cash its invoice collected. The reconcile's own suite
 * (`xero-inbound-reconciliation.test.ts`) drives it through the settle; this
 * pins every refusal on its own.
 */
const primary = (overrides: Partial<CashSettlementTransaction> = {}): CashSettlementTransaction => ({
  kind: "PRIMARY",
  source: "INTERNET_BANKING",
  status: "PENDING",
  amountCents: 30_000,
  ...overrides,
});

const base = {
  paymentStatus: "PENDING" as const,
  refundedAmountCents: 0,
  transactions: [primary()],
  cash: { knownCents: 20_000, complete: true },
  matchedPayments: 1,
  secondInstrument: false,
};

describe("planInternetBankingCashSettlement (#3979, INV-PAY-124)", () => {
  it("rewrites to the cash at the transition", () => {
    expect(planInternetBankingCashSettlement(base)).toEqual({ kind: "rewrite", amountCents: 20_000 });
  });

  it("rewrites when no PRIMARY row exists yet (the settle mints one)", () => {
    expect(planInternetBankingCashSettlement({ ...base, transactions: [] })).toEqual({
      kind: "rewrite",
      amountCents: 20_000,
    });
  });

  it("rewrites a FAILED PRIMARY row (a cancelled booking's never-captured payment)", () => {
    expect(
      planInternetBankingCashSettlement({ ...base, paymentStatus: "FAILED", transactions: [primary({ status: "FAILED" })] }),
    ).toEqual({ kind: "rewrite", amountCents: 20_000 });
  });

  it.each(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const)(
    "decides nothing again once the PRIMARY row is %s (a replay)",
    (status) => {
      expect(planInternetBankingCashSettlement({ ...base, transactions: [primary({ status })] })).toEqual({ kind: "replay" });
    },
  );

  it("a captured card row is not the bank receipt: the transition is still open", () => {
    const plan = planInternetBankingCashSettlement({
      ...base,
      transactions: [primary(), { kind: "PRIMARY", source: "STRIPE", status: "SUCCEEDED", amountCents: 30_000 }],
    });
    expect(plan).toEqual({ kind: "keep", reason: "other-capture" });
  });

  it.each([
    ["second-instrument", { secondInstrument: true }],
    ["cash-incomplete", { cash: { knownCents: 20_000, complete: false } }],
    ["cash-zero", { cash: { knownCents: 0, complete: true } }],
    ["several-payments", { matchedPayments: 2 }],
    ["refund-history", { refundedAmountCents: 1 }],
    ["refund-history", { paymentStatus: "PARTIALLY_REFUNDED" as const }],
    ["refund-history", { paymentStatus: "REFUNDED" as const }],
    ["other-capture", { transactions: [primary(), { kind: "ADDITIONAL", source: "STRIPE", status: "SUCCEEDED", amountCents: 1 } as CashSettlementTransaction] }],
    ["several-primary-rows", { transactions: [primary(), primary()] }],
  ] as const)("keeps the stored figure: %s", (reason, overrides) => {
    expect(planInternetBankingCashSettlement({ ...base, ...overrides })).toEqual({ kind: "keep", reason });
  });

  it("an uncaptured card row does not refuse the rewrite", () => {
    const plan = planInternetBankingCashSettlement({
      ...base,
      transactions: [primary(), { kind: "PRIMARY", source: "STRIPE", status: "FAILED", amountCents: 30_000 }],
    });
    expect(plan).toEqual({ kind: "rewrite", amountCents: 20_000 });
  });
});

describe("cashSettlementNoticeMessage (#3979)", () => {
  it("names the kept figure, the cash and the reason", () => {
    const message = cashSettlementNoticeMessage(
      {
        storedAmountCents: 30_000,
        cash: { knownCents: 20_000, complete: true },
        refusal: "several-payments",
        owedCents: null,
        hasSupplementaryInvoice: false,
      },
      CLUB_FORMAT_TEST,
    );
    expect(message).toContain("paid with $200.00");
    expect(message).toContain("kept the $300.00 it had recorded");
    expect(message).toContain("matched more than one payment");
  });

  it("says when the cash disagrees with what is owed", () => {
    const message = cashSettlementNoticeMessage(
      {
        storedAmountCents: 20_000,
        cash: { knownCents: 20_000, complete: true },
        refusal: null,
        owedCents: 25_000,
        hasSupplementaryInvoice: true,
      },
      CLUB_FORMAT_TEST,
    );
    expect(message).toBe(
      "The cash Xero shows, $200.00, is not what the booking owes ($250.00). The booking also has a supplementary invoice for a later change. If the member paid too much, refund or credit the difference; if too little, collect the rest.",
    );
  });

  it("never states an unreadable figure as exact", () => {
    const message = cashSettlementNoticeMessage(
      {
        storedAmountCents: 30_000,
        cash: { knownCents: 20_000, complete: false },
        refusal: "cash-incomplete",
        owedCents: null,
        hasSupplementaryInvoice: false,
      },
      CLUB_FORMAT_TEST,
    );
    expect(message).toContain("an amount it could not read exactly (its figures come to $200.00)");
  });
});
