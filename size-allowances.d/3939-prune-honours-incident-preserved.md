# File-size allowances for #3939

file: src/lib/audit-retention.ts
lines: 846
reason: the ten-year cap for incident-preserved rows is one named constant
  beside the other retention periods, one cutoff in the shared cutoff helper,
  and one condition inside each of the two prune statements (the main-table
  deleteMany and the archive DELETE); the note on how the cap composes with
  the normal rules and the archive gate has to sit on the predicate it
  qualifies. Splitting the retention module is a refactor of its own and would
  separate the prune from the archive gate it composes with.
