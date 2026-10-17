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

/**
 * The two reasons a confirm gives, each with its own effect (owner decision 17
 * Oct 2026): the refund was cancelled - the money never went out, so it is
 * taken back out of the payment's records - or the note was replaced by hand in
 * Xero - the money went out and Xero has a live note, so nothing moves. Stored
 * as its own outcome on the resolution, never as words in the note.
 */
export const BANK_REFUND_VOID_CONFIRM_REASONS = ["cancelled", "replaced-in-xero"] as const;
export type BankRefundVoidConfirmReason = (typeof BANK_REFUND_VOID_CONFIRM_REASONS)[number];

/** The resolution outcome each reason records. */
export const CONFIRM_REASON_OUTCOME = {
  cancelled: "CONFIRMED_CANCELLED",
  "replaced-in-xero": "CONFIRMED_REPLACED_IN_XERO",
} as const satisfies Record<BankRefundVoidConfirmReason, string>;

/** Each reason as the dialog offers it: its name and what it does, in plain English. */
export const CONFIRM_REASON_COPY: Record<BankRefundVoidConfirmReason, { label: string; help: string }> = {
  cancelled: {
    label: "Refund cancelled",
    help: "The member was never paid. The refund is taken back out of the payment's records and its ledger line is reversed.",
  },
  "replaced-in-xero": {
    label: "Replaced by hand in Xero",
    help: "The member was paid, and a credit note you made in Xero records it. Nothing in the club's records changes.",
  },
};
