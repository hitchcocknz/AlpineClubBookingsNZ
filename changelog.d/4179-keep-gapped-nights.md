- **Approving a change request no longer fills the gaps in a guest's stay
  (#4157).** Some guests stay on nights with gaps between them, for example
  the 10th and the 12th but not the 11th. When a member sent a change request
  with ordinary Date In and Date Out rather than the night-by-night grid, the
  form sent that guest's own dates back unchanged. On a finished stay,
  approving the request then put the guest on every night between those dates
  and charged for the gaps.

  Approving now keeps the nights such a guest already has, and charges nothing
  for them. Only a guest whose dates really change is put on every night of
  their new dates, as before. The officer's card on Booking Requests now lists
  that guest's own nights and marks them "(no change)". "(fills the gaps in
  their stay)" now appears only where a guest's dates really move.
