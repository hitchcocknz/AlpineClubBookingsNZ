-- #4453 review (S-F1): a ledger line may not be rewritten through its parent's key.
--
-- With the least-privilege roles the application may only INSERT and SELECT
-- "BookingLedgerLine". A referential action, though, runs with the rights of the
-- referencing table's OWNER, so `ON UPDATE CASCADE` let an application that
-- could UPDATE "Booking"."id" or "Lodge"."id" rewrite `bookingId` and `lodgeId`
-- on posted lines it may not touch directly. Both keys become ON UPDATE RESTRICT:
-- changing a parent key that a ledger line names is refused.
--
-- `bookingId` KEEPS `ON DELETE CASCADE`: deleting a booking still removes its
-- lines. That is booking deletion's behaviour, not this grant's, and whether it
-- should change belongs to the ledger design. `lodgeId` keeps `ON DELETE RESTRICT`.
--
-- OLD CODE: nothing in the application, the scripts or the migrations updates
-- "Booking"."id" or "Lodge"."id" (census in the #4479 PR), so both colours behave
-- exactly as before. No row changes: this is shape-only.
--
-- DEPLOY: PostgreSQL cannot change a foreign key's action in place, so each key
-- is dropped and re-added under the same name inside one transaction; there is
-- no moment without the key. The DROP CONSTRAINT makes the blue/green guard
-- classify this migration as breaking, so the release carrying it runs with
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 and a reason, as
-- 20261014010000_add_unsized_part_payment_review_task did; the operator checks
-- that each found_breaking line names a reviewed "yes" row in
-- docs/BLUE_GREEN_MIGRATION_SAFETY.tsv.
BEGIN;

ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_bookingId_fkey";
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "BookingLedgerLine" DROP CONSTRAINT "BookingLedgerLine_lodgeId_fkey";
ALTER TABLE "BookingLedgerLine" ADD CONSTRAINT "BookingLedgerLine_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
