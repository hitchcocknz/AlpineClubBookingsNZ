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
  to every dashboard load, which #2091 removed on purpose. Re-measured at 998
  by the hand sync of `main` f3b6c008b into epic #3789, which composes these
  lines with `main`'s #3636/#3924 Net Collected and Refunds/Credits owed reads
  in the same batch (main's own allowance for them is inert against `main`).
