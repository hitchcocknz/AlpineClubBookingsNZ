import type { MemberMoneyAccount } from "@prisma/client";
import type { AccountMappingKey } from "../../xero-account-mapping-keys";

/** Stable economic identities; the settings registry owns provider codes/fallbacks. */
export const MEMBER_MONEY_ACCOUNTS = {
  MEMBER_RECEIVABLE: { normalSide: "DEBIT", mappingKey: "memberReceivable", route: "DOCUMENT_CONTROL" },
  STRIPE_CLEARING: { normalSide: "DEBIT", mappingKey: "stripeBankAccount", route: "ACCOUNT" },
  BANK: { normalSide: "DEBIT", mappingKey: "memberReceiptsBankAccount", route: "ACCOUNT", refundMappingKey: "bankTransferRefundAccount" },
  CASH: { normalSide: "DEBIT", mappingKey: "memberCashAccount", route: "ACCOUNT" },
  MEMBER_CREDIT: { normalSide: "CREDIT", mappingKey: "memberCreditLiability", route: "DOCUMENT_CONTROL" },
  REFUND_PAYABLE: { normalSide: "CREDIT", mappingKey: "memberRefundPayable", route: "DOCUMENT_CONTROL" },
  BOOKING_REVENUE: { normalSide: "CREDIT", mappingKey: "hutFeesIncome", route: "ACCOUNT", refundMappingKey: "hutFeeRefunds" },
  SUBSCRIPTION_REVENUE: { normalSide: "CREDIT", mappingKey: "subscriptionIncome", route: "ACCOUNT" },
  JOINING_FEE_REVENUE: { normalSide: "CREDIT", mappingKey: "joiningFeeIncome", route: "ACCOUNT" },
  FEE_REVENUE: { normalSide: "CREDIT", mappingKey: "memberFeesIncome", route: "ACCOUNT" },
  GST_PAYABLE: { normalSide: "CREDIT", mappingKey: "memberGstPayable", route: "DOCUMENT_CONTROL" },
  STRIPE_FEES: { normalSide: "DEBIT", mappingKey: "stripeFees", route: "ACCOUNT" },
  GOODWILL: { normalSide: "DEBIT", mappingKey: "goodwillWriteOffs", route: "ACCOUNT" },
  EXTERNAL_CONTROL: { normalSide: "EITHER", mappingKey: "memberExternalControl", route: "ACCOUNT" },
  OPENING_CONTROL: { normalSide: "EITHER", mappingKey: "memberOpeningControl", route: "ACCOUNT" },
} as const satisfies Record<MemberMoneyAccount, {
  normalSide: "DEBIT" | "CREDIT" | "EITHER";
  mappingKey: AccountMappingKey;
  refundMappingKey?: AccountMappingKey;
  route: "ACCOUNT" | "DOCUMENT_CONTROL";
}>;
