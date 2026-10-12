# File-size allowances for #4042

file: src/components/admin/manual-refund-task-queue.tsx
lines: 2215
reason: the finance queue card gains the group organiser hand-back's own
  explaining paragraph and the flag that keeps the cash paragraph from
  speaking for it; every other kind's paragraph and flag live in this same
  render, so the new one has to sit beside them rather than in a module of
  its own; so do the group row's paid-back dialog wording and the Dismiss
  control it does not offer.

file: src/lib/email-message-registry.ts
lines: 2247
reason: the "Manual refund needed" message gains its two note tokens, which
  the registry declares in its three existing tables (required body tokens,
  editor previews, the token allowlist) beside every other composed note; the
  trigger summary and frequency now name the group case; the third token
  (whom the money goes back to) and the required subject token sit in the
  same tables.

file: src/lib/group-cancel.ts
lines: 960
reason: nine lines book each joiner's share on the organiser's hand-back inside
  the per-child claim that records it (the writer itself is
  `group-organiser-hand-back.ts`), carry it out of the claim, name it in the
  child's audit, send its alert straight after the claim that created it
  commits, and kick the group invoice's VOID after the children so its refusal
  can name the task; each has to sit in the claim or the loop it belongs to.
