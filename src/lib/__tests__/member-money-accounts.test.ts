import { MemberMoneyAccount } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MEMBER_MONEY_ACCOUNTS } from "@/lib/member-money";
import { ACCOUNT_MAPPING_KEYS, accountsForMappingKey, resolveAccountMappingSource } from "@/lib/xero-account-mapping-keys";

describe("member money chart (#4513)", () => {
  it("covers every economic account with a registered settings key, without provider codes", () => {
    expect(Object.keys(MEMBER_MONEY_ACCOUNTS).sort()).toEqual(Object.values(MemberMoneyAccount).sort());
    for (const account of Object.values(MEMBER_MONEY_ACCOUNTS)) {
      expect(ACCOUNT_MAPPING_KEYS).toContain(account.mappingKey);
      if ("refundMappingKey" in account) expect(ACCOUNT_MAPPING_KEYS).toContain(account.refundMappingKey);
    }
  });
  it("keeps system control accounts on document routes and preserves the fee fallback", () => {
    for (const key of ["MEMBER_RECEIVABLE", "MEMBER_CREDIT", "GST_PAYABLE"] as const) {
      expect(MEMBER_MONEY_ACCOUNTS[key].route).toBe("DOCUMENT_CONTROL");
    }
    expect(resolveAccountMappingSource(MEMBER_MONEY_ACCOUNTS.FEE_REVENUE.mappingKey, false))
      .toEqual({ sourceKey: "hutFeesIncome", usingFallback: true });
    expect(MEMBER_MONEY_ACCOUNTS.BANK.refundMappingKey).toBe("bankTransferRefundAccount");
  });
  it("allows Finance's clearing/equity choice without admitting income or expense accounts", () => {
    const chart = [
      { type: "CURRENT", class: "ASSET" }, { type: "EQUITY", class: "EQUITY" },
      { type: "REVENUE", class: "REVENUE" }, { type: "EXPENSE", class: "EXPENSE" },
    ];
    expect(accountsForMappingKey("memberOpeningControl", chart)).toEqual(chart.slice(0, 2));
    expect(accountsForMappingKey("memberReceiptsBankAccount", [...chart, { type: "BANK", class: "ASSET" }]))
      .toEqual([{ type: "BANK", class: "ASSET" }]);
  });
});
