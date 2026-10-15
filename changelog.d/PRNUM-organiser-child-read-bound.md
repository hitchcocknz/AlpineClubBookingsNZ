- **The payments job's check on group organiser card refunds can no longer
  hang on a slow card provider (#4130).** Each check now gives up after ten
  seconds without retrying, and the whole pass stops after a minute, as the
  card-refund check that runs after it already did. The refunds it skips are
  checked on the next run.
