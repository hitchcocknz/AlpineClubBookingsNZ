-- #69: two Other lodges may share a name; the central server's id is what
-- makes them distinct (owner decision, 15 Oct 2026). The partial unique index
-- on visible names (#58) is replaced by a plain index, kept for the download's
-- and the committee sync's lookups by name.
--
-- One index swap. NO DML.
--
-- WINDOWED, NOT OLD-CODE COMPATIBLE (docs/BLUE_GREEN_MIGRATION_SAFETY.tsv;
-- owner decision, 24 Oct 2026, #4262), in ONE window with
-- 20261123040000_other_lodge_hidden_at and never applied apart from it. The
-- previous release relies on one lodge per name: its download's upsert keys
-- on the name, and its owned-lodge answer is by name, so once two rows share a
-- name its admin edit route and committee booking-officer sync would treat
-- another club's lodge of that name as this club's. The old web colour and
-- every old worker are stopped, and their connections drained, before this
-- runs. Reverse: rollback.sql beside this file, FIRST; it refuses while two
-- visible lodges share a name.
--
-- LOCK IMPACT: brief ACCESS EXCLUSIVE locks on "OtherLodge", a small admin
-- registry, not a hot table; the new index builds over its few hundred rows.

-- A lodge name is no longer unique, among visible lodges or any.
DROP INDEX "OtherLodge_name_visible_key";
CREATE INDEX "OtherLodge_name_idx" ON "OtherLodge"("name");
