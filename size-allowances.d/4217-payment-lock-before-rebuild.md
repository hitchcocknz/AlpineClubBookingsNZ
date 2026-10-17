# File-size allowances for #4217 — the Payment row before every ledger-row write and the rebuild

The rule is one call, `lockPaymentForRefundedTotal`, at the top of each writer.
What each file below gains is that call in the one place its own transaction
writes a payment's ledger rows, and the wrap that keeps the lock held until the
rebuild has written. No new module would hold any of it: the lock must sit
inside each writer, before its first statement.

file: src/lib/payment-transactions.ts
lines: 1689
reason: the five ledger-row writers and the aggregate rebuild live here, and
  each now runs in the caller's transaction or a short one of its own
  (`withStoreTransaction`) with the lock as its first statement. The two mark
  writers gain a pure read of which payment to lock and a re-read under it (two
  small private helpers beside `findPaymentByIntentPointer`, which they reuse),
  and mark-failed's captured check becomes a status-guarded write. Splitting
  them out would separate each writer from the lock that has to precede it.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2069
reason: the Internet Banking settle's transaction is the only place its locks
  are taken, so the Payment row lock (owner decision Q2 on #4217) goes there,
  after the member key, with the re-read of the payment's figures under it and
  the same source check the pre-lock read already makes: one call, one read,
  three guard lines and a two-line comment.

file: src/lib/payment-reconciliation.ts
lines: 3115
reason: the Stripe settle's transaction body is where its Payment row is first
  reached, so the lock goes straight after that upsert and before the ledger
  lookup that may backfill: one call and a one-line comment.
