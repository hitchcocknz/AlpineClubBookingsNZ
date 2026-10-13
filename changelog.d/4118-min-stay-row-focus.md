- **Keyboard focus now stays in the list after a booking policy row is
  activated, deactivated or deleted (#4116).** On the Minimum night stay card,
  these buttons reload the list, which used to drop keyboard and screen-reader
  users to the top of the page. Focus now returns to the same row's
  Activate/Deactivate button (a deleted minimum-stay policy stays listed as
  inactive), or to the card if the row is gone. On the Date-specific periods
  card, deleting a period now moves focus to the next period's Delete button
  (the previous one's for the last period), or to the card when none are left,
  and Activate/Deactivate keeps focus on its button after the change. Nothing
  needs configuring.
