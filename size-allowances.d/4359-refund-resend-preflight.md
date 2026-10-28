file: src/lib/payment-recovery.ts
lines: 3562
reason: the preflight rule lives in its own module; these call sites must precede both charge-backed executors and the hold must use the existing guarded failure transition rather than creating another status writer.
