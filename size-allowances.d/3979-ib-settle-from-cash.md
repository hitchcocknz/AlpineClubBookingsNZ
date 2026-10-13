# File-size allowances for #3979 (settle a bank transfer from its invoice's cash)

Two already-over-budget Xero inbound modules grow. The new rule's logic lives
in its own module, `src/lib/xero-inbound/settle-from-cash.ts`, written to its
ceiling; what stays in these two files is the call sites, which belong where the
writes and the locks are.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1989
reason: the receipt figure is decided and written inside the settle's own
  locked transaction, between the #2262 and #3638 fences and the ledger's
  receipt sync, and the in-memory row is updated there so both cancel arms size
  their credit from it. Moving the writes out would split one transaction's
  ordering argument (INV-LOCK-002, INV-PAY-124) across two files. The decision,
  the cross-check and the alert are already in `settle-from-cash.ts`; what is
  left is the call, the two amount writes and the post-commit alert call.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1194
reason: `resolveModificationRefundAmountsByPaymentId` is the inbound credit-note
  sync's current-note half of the refunded-total repair that lives in this
  file, moved here from `credit-note.ts` so it can be called (and proved
  against PostgreSQL) without a Xero client. It uses the module's own
  invoice-to-payment resolver; a separate module would export that resolver
  only to call it back. The rest is one guard in the repair's own status
  decision (never un-refund a payment with nothing captured to SUCCEEDED),
  which belongs beside the Stripe floor it sits under.
