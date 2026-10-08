# File-size allowances for #3939

file: src/lib/audit-retention.ts
lines: 819
reason: the incident-preservation exemption is one condition inside each of
  the two prune statements (the main-table deleteMany and the archive DELETE),
  and the note saying why it is top-level has to sit on the predicate it
  guards. Splitting the retention module is a refactor of its own and would
  separate the prune from the archive gate it composes with.
