# File-size allowance for #4256

file: src/lib/xero-operation-retry.ts
lines: 2032
reason: the PARTIAL invoice and refund-note repairs now run inside the one
  claim-and-abandon helper this module owns (`runWithClaimedOriginal`), which
  gains its PARTIAL-only mode and a replayable guard. The growth is the wrap
  at the two call sites and the give-back branch beside the FAILED one; the
  completion builder already moved out to xero-partial-invoice-repair-amount.ts.
  The review round added the FAILED refund-note repair's claim, the claim
  instant threaded to each repair's completion, and the not-replayable
  refusal the queued-retry drain skips. Splitting the helper away from
  `throwLostRetryClaim` and the resolved-in-Xero refusal it calls would
  separate the claim from the rule it enforces.
