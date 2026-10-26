# File-size allowance for #4095 items 5 and 12

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2084
reason: the settle's per-payment loop records which applied invoice corrections
  a kept figure leaves uncounted, and calls the recount after its commit, beside
  the other post-commit steps (hosting drain, settlement alert). The recount
  itself lives in its own module, `kept-settle-correction-recount.ts`; only the
  two declarations, the one assignment, the import and the call stay here,
  plus the result's count of notes left unrecounted, which fails the event so
  it is retried.
