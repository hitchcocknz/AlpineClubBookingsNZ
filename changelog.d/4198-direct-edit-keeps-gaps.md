- **Editing a booking no longer fills the gaps in a guest's stay (#4189).**
  Some guests stay on nights with gaps between them, for example the 10th and
  the 12th but not the 11th. Where a club has per-guest dates turned on and the
  night-by-night grid turned off, the booking editor sends every guest's Date
  In and Date Out when a member or an officer saves an edit, even for a guest
  nobody touched. Saving then put that guest on every night between their
  dates and charged for the gaps, and the price shown before saving included
  them too.

  An edit now keeps the nights such a guest already has, and charges nothing
  for them; the price shown before saving agrees. Only a guest whose dates
  really change is put on every night of their new dates, as before. This is
  the same rule approving a change request has followed since #4157. A
  booking-policy exception request sent before this release that carries such a
  guest's dates is refused on approval as changed since it was sent, rather
  than approved with the gaps filled; the member can send it again.
