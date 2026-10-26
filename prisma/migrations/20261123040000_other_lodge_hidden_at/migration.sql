-- #58: hide an Other lodges row instead of deleting it, when the Alpine Central
-- Server reports the lodge deleted (API 2.4) or an administrator hides a lodge
-- the server does not list. The row stays, so bookings and booking requests
-- that name it keep it.
--
-- Lodge names become unique among VISIBLE lodges only: two lodges may share a
-- name (the id makes them distinct), so a hidden lodge keeps its name for the
-- bookings that name it without blocking a live lodge of the same name. The
-- full unique index is replaced by a partial one.
--
-- One nullable column with no default, and the name index swap. NO DML.
--
-- WINDOWED, NOT OLD-CODE COMPATIBLE (docs/BLUE_GREEN_MIGRATION_SAFETY.tsv;
-- owner decision, 24 Oct 2026, #4262). The previous release's download creates
-- a lodge with a Prisma upsert keyed on the name, whose INSERT ... ON CONFLICT
-- ("name") needs the full unique index this drops: once it commits, every
-- such upsert fails, and a version pause does not stop a download already in
-- flight. So the old web colour and every old worker are stopped, and their
-- database connections drained, before this runs, in ONE window with
-- 20261123050000_other_lodge_names_not_unique. Reverse: rollback.sql beside
-- this file, AFTER 20261123050000's; it refuses while two rows share a name.
--
-- LOCK IMPACT: brief ACCESS EXCLUSIVE locks on "OtherLodge", a small admin
-- registry, not a hot table; the new index builds over its few hundred rows.

-- AlterTable
ALTER TABLE "OtherLodge" ADD COLUMN "hiddenAt" TIMESTAMP(3);

-- A lodge name is unique among visible lodges only.
DROP INDEX "OtherLodge_name_key";
CREATE UNIQUE INDEX "OtherLodge_name_visible_key" ON "OtherLodge"("name") WHERE "hiddenAt" IS NULL;
