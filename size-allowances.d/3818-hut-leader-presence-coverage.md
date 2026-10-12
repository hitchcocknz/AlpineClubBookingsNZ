# File-size allowance for #3818 (presence-aware hut-leader coverage)

file: src/app/(admin)/admin/dashboard/page.tsx
lines: 998
reason: the hut-leader read stays in the page's one batched `Promise.all`
  but now waits on the shared permission-matrix promise, so it can skip the
  "Handovers this week" read (and the names it needs) for an actor who cannot
  see that card without serialising the batch; the page then labels the
  uncovered nights in the club's date format and mounts the new card. The card
  itself (`hut-leader-handovers-card.tsx`), the combined read
  (`getHutLeaderDashboardCoverage`) and the uncovered-night label
  (`uncoveredNightLabel`) live outside the page to keep the growth to these
  wiring lines; moving the read out of the batch would add a second round trip
  to every dashboard load, which #2091 removed on purpose.

file: src/lib/lodge-display-state.ts
lines: 941
reason: the owner's "Show once, as custodian" (13 Oct 2026, #3820) has to drop
  a custodian's own guest nights from the booking rows the wall builds, and
  only this builder holds both today's custodian read and those rows. The
  rule itself is one shared helper (`isCustodianOnNight` in
  `custodian-occupancy.ts`) the member roster calls too; here it costs the two
  selected columns, the custodian nights in key form and the one filter.
