import { describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import {
  cashSettlementNoticeMessage,
  planInternetBankingCashSettlement,
  readCashSettlementNotice,
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
  refundedAmountCents: 0,
  ...overrides,
});

const base = {
  refundedAmountCents: 0,
  transactions: [primary()],
  cash: { knownCents: 20_000, complete: true },
  matchedPayments: 1,
  secondInstrument: false,
};

describe("planInternetBankingCashSettlement (#3979, INV-PAY-124)", () => {
  const rewrite = (receiptCents: number, paymentAmountCents = receiptCents) => ({
    kind: "rewrite",
    receiptCents,
    paymentAmountCents,
  });

  it("rewrites to the cash at the transition", () => {
    expect(planInternetBankingCashSettlement(base)).toEqual(rewrite(20_000));
  });

  it("rewrites when no PRIMARY row exists yet (the settle mints one)", () => {
    expect(planInternetBankingCashSettlement({ ...base, transactions: [] })).toEqual(rewrite(20_000));
  });

  it("rewrites a FAILED PRIMARY row (a cancelled booking's never-captured payment)", () => {
    expect(
      planInternetBankingCashSettlement({ ...base, transactions: [primary({ status: "FAILED" })] }),
    ).toEqual(rewrite(20_000));
  });

  it.each(["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const)(
    "decides nothing again once the PRIMARY row is %s (a replay)",
    (status) => {
      expect(planInternetBankingCashSettlement({ ...base, transactions: [primary({ status })] })).toEqual({ kind: "replay" });
    },
  );

  it("a card capture refunded before the switch (#1765) stays on the payment: the receipt is the cash, the payment the cash plus the card", () => {
    const card: CashSettlementTransaction = {
      kind: "PRIMARY",
      source: "STRIPE",
      status: "REFUNDED",
      amountCents: 30_000,
      refundedAmountCents: 30_000,
    };
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 30_000, transactions: [card, primary()] }),
    ).toEqual(rewrite(20_000, 50_000));
  });

  it("a captured addition counts towards the payment's figure, never the receipt", () => {
    const addition: CashSettlementTransaction = {
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      amountCents: 500,
      refundedAmountCents: 0,
    };
    expect(planInternetBankingCashSettlement({ ...base, transactions: [primary(), addition] })).toEqual(
      rewrite(20_000, 20_500),
    );
  });

  it.each([
    ["second-instrument", { secondInstrument: true }],
    ["cash-incomplete", { cash: { knownCents: 20_000, complete: false } }],
    ["cash-zero", { cash: { knownCents: 0, complete: true } }],
    ["several-payments", { matchedPayments: 2 }],
    ["folded-refund", { refundedAmountCents: 1 }],
    ["several-primary-rows", { transactions: [primary(), primary()] }],
  ] as const)("keeps the stored figure: %s", (reason, overrides) => {
    expect(planInternetBankingCashSettlement({ ...base, ...overrides })).toEqual({ kind: "keep", reason });
  });

  it("a refunded total a row records is not a fold", () => {
    const card: CashSettlementTransaction = {
      kind: "PRIMARY",
      source: "STRIPE",
      status: "PARTIALLY_REFUNDED",
      amountCents: 30_000,
      refundedAmountCents: 10_000,
    };
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 15_000, transactions: [card, primary()] }),
    ).toEqual({ kind: "keep", reason: "folded-refund" });
    expect(
      planInternetBankingCashSettlement({ ...base, refundedAmountCents: 10_000, transactions: [card, primary()] }),
    ).toEqual(rewrite(20_000, 50_000));
  });

  it("an uncaptured card row does not refuse the rewrite", () => {
    const plan = planInternetBankingCashSettlement({
      ...base,
      transactions: [primary(), { kind: "PRIMARY", source: "STRIPE", status: "FAILED", amountCents: 30_000, refundedAmountCents: 0 }],
    });
    expect(plan).toEqual(rewrite(20_000));
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

describe("readCashSettlementNotice (#3979)", () => {
  // Any read through this client fails the test: these plans ask nothing.
  const untouchable = new Proxy({}, {
    get: (_target, property) => {
      throw new Error(`unexpected read of tx.${String(property)}`);
    },
  }) as never;
  const input = {
    storedAmountCents: 30_000,
    cash: { knownCents: 20_000, complete: true },
    matchedPayments: 1,
    booking: { id: "b-1", finalPriceCents: 25_000, cancelled: false },
    changeFeeCents: null,
  };

  it.each([
    ["a replay", { kind: "replay" } as const],
    ["a second instrument (#3638 alerts on its own)", { kind: "keep", reason: "second-instrument" } as const],
  ])("says nothing, and reads nothing, for %s", async (_label, plan) => {
    expect(await readCashSettlementNotice(untouchable, { ...input, plan })).toBeNull();
  });

  it("does not cross-check a cancelled booking: its late-cash arm alerts on its own", async () => {
    expect(
      await readCashSettlementNotice(untouchable, {
        ...input,
        plan: { kind: "rewrite", receiptCents: 20_000, paymentAmountCents: 20_000 },
        booking: { ...input.booking, cancelled: true },
      }),
    ).toBeNull();
  });
});
