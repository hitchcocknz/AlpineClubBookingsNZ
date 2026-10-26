# File-size allowances for #4479 — least-privilege database roles (#4453)

Two already-oversized modules grow because this change keeps one source for
something that would otherwise be copied.

file: src/lib/audit-retention.ts
lines: 888
reason: the optional `AUDIT_RETENTION_DATABASE_URL` client, built by the one
  `createStandaloneClient` helper that the archive client already used, and the
  job's selection between it and the app client. Moving retention's connection
  handling to another module would split the job from the client it must run
  on, which is the pairing the realdb test proves.

file: src/lib/diagnostics/tools/provision-role.ts
lines: 1165
reason: `buildCreateLoginRoleIfAbsentSql` and `buildStripAllRoleMembershipsSql`
  became shared exports so the new role builder reuses the AI Diagnostics
  builder's role-creation and membership-strip SQL instead of copying it
  (INV-SSOT). The diagnostics builder's statement list is byte-identical.
