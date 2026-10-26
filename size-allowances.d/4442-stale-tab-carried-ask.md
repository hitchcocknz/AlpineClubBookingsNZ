# File-size allowances for #4442

A new additional ask must not carry money a stale tab paid between its sizing
and its queue. The recovery runner is one of the three writers of that ask, so
its replay re-reads the carried balance under the same locks as the others.

file: src/lib/payment-recovery.ts
lines: 3407
reason: two lines in the additional-ask replay - the import of the shared
  queue fence and the re-read inside the runner's claim hold - beside the
  claim, the mint and the supersede they guard. The lock order itself lives in
  `lockAdditionalAskQueue` in `additional-ask-queue-transaction.ts`, so the
  claim hold did not grow; lifting the whole replay out of this module is a
  refactor of its own.
