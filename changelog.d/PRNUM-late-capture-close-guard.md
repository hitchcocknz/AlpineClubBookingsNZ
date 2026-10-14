- **An approved late-card-charge refund no longer marks its retry record as
  done from under another process (#4126).** After a treasurer approves the
  refund of a late card charge, the app marked its retry record as done
  without checking whether the record had already moved on, for example
  because it was re-planned after a refusal, or picked up by the retry worker.
  It now marks it done only when the record is exactly as the approval left
  it. Otherwise the retry worker finishes it and writes the refund record
  once.
