- **An audit entry kept as evidence of an incident is no longer deleted when
  its retention period runs out (#3939).** The nightly retention job already
  kept the IP address and browser details of an entry marked as preserved for
  an incident, but it still deleted the entry itself at its expiry date, which
  defeated the point of preserving it. Preserved entries are now never deleted,
  from the audit log or from the audit archive. Today these are the entries for
  an admin capacity hold or force-confirm that overbooked the lodge.

  Nothing is deleted on the first run after the upgrade; this change only keeps
  rows. Preserved entries now stay indefinitely and there is no in-app control
  to release one. The
  [retention runbook](../docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md#incident-preserved-rows-are-never-pruned-3939)
  has a read-only query to count them.
