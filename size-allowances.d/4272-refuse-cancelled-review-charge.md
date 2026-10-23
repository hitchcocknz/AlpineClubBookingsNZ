# File-size allowances for #4272: a cancelled booking's review charge

file: src/lib/edit-financial-review-settlement.ts
lines: 710
reason: #4272's re-read of the booking's cancellation before the Xero leg, and
  #3949's organiser-by-bank review route, both landed in this file, and together
  they take it 10 lines past its 700 budget. The file belongs to the officer
  edit-review machinery that epic #4302 removes outright in wave C (owner
  decision, 23 Oct 2026), so it is allowed rather than split. A split would
  only move code that is about to be deleted.
