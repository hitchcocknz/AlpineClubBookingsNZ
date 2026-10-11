# File-size allowances for #4042

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2206
reason: the finance queue card gains the group organiser hand-back's own
  explaining paragraph and the flag that keeps the cash paragraph from
  speaking for it; every other kind's paragraph and flag live in this same
  render, so the new one has to sit beside them rather than in a module of
  its own.

file: src/lib/email-message-registry.ts
lines: 2242
reason: the "Manual refund needed" message gains its two note tokens, which
  the registry declares in its three existing tables (required body tokens,
  editor previews, the token allowlist) beside every other composed note; the
  trigger summary and frequency now name the group case.
