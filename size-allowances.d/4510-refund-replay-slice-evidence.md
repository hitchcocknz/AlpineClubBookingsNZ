# File-size allowances for #4510

file: src/lib/payment-recovery.ts
lines: 3574
reason: both existing refund executors must consume the preflight's returned plan; extracting the surrounding executor is outside this guarded replay fix.

file: src/lib/payment-transactions.ts
lines: 1724
reason: the keyed Stripe request must attach and bound its own slice evidence beside its existing idempotency key; splitting these few lines would separate the request from its evidence.
