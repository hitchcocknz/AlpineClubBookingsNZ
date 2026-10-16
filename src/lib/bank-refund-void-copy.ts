/**
 * #4162 (`INV-ADDPAY-042`): the words and choices the voided bank-transfer
 * refund list shares between its writers (`bank-refund-void-resolution.ts`),
 * its routes and its panel. A pure leaf with no server dependency, so the
 * client panel and the server say the same thing (`INV-SSOT-001`).
 */

/** Why a record-again would be refused now (`bank-refund-void-report.ts`). */
export type ReRecordRefusal = "amount-unknown" | "note-in-flight" | "resolved-in-xero";

/** What the panel and the writer say when a record-again is refused for one of the list's reasons. */
export const RE_RECORD_REFUSAL_MESSAGES: Record<ReRecordRefusal, string> = {
  "amount-unknown":
    "The voided note's amount cannot be read, so it cannot be recorded again or confirmed here. Ask a developer to reconcile it.",
  "note-in-flight":
    "Another refund credit note on this payment is still on its way to Xero. Wait for it to finish, then try again.",
  "resolved-in-xero":
    "This note was marked resolved by hand in Xero, so recording it again could credit the member twice. Raise any further note in Xero by hand, then confirm it here.",
};

/** The reasons a confirm may give: the refund was cancelled, or its note was replaced by hand in Xero. */
export const BANK_REFUND_VOID_CONFIRM_BASES = ["cancelled", "replaced-in-xero"] as const;
export type BankRefundVoidConfirmBasis = (typeof BANK_REFUND_VOID_CONFIRM_BASES)[number];

/** How each basis is written at the head of the stored reason, and offered in the dialog. */
export const CONFIRM_BASIS_LABEL: Record<BankRefundVoidConfirmBasis, string> = {
  cancelled: "Refund cancelled",
  "replaced-in-xero": "Replaced by hand in Xero",
};
