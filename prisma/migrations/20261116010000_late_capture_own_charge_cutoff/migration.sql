-- #4131: a marker, not a schema change. When this migration finished on an
-- install dates the end of the previous release's late-capture refund plan
-- (`LATE_CAPTURE_OWN_CHARGE_CUTOFF_MIGRATION` in src/lib/late-capture-own-charge-refund.ts):
-- that release could refund part of a late capture from another of the booking's
-- charges, and only a refund made before this marker (plus the blue/green overlap)
-- is ever read as such a slice on a deploy replay.
-- Readable by the previous release: it changes nothing it reads.
SELECT 1;
