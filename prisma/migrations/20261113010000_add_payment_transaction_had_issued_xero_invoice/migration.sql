BEGIN;

-- #3954 review round 7 (INV-PAY-120): stamp on an ADDITIONAL request row the
-- edit's own answer to "had the booking's primary Xero invoice been issued?"
-- (`hasIssuedPrimaryXeroInvoice`) at the moment that edit asked for the money.
--
-- A later price reduction that cancels or shrinks the unpaid request splits
-- what it released between a supplementary invoice and an invoice-correction
-- note on the primary invoice. Which one billed the request's own money is
-- exactly that answer: true, its own supplementary invoice bills it; false,
-- the primary invoice raised afterwards bills it. It used to be guessed from
-- when the row was written against when the primary invoice was linked, which
-- a recovery minted hours later, or a backfilled link, gets wrong.
-- PaymentRecoveryOperation.hadIssuedXeroInvoice (#3181) already freezes the
-- same answer for a failed mint's retry; this is its twin for the request row.
--
-- EXPAND ONLY, one nullable column, no DML, no default: NULL means "not
-- recorded", which is the truth for every stored row. A reader that meets NULL
-- falls back to the minting recovery's own answer, and failing that reports the
-- offset for a person rather than guessing. A draining old colour omits the
-- column on INSERT and never reads it; its rows are NULL, read the same way.
--
-- LOCK IMPACT: ADD COLUMN with no default is catalog-only on PostgreSQL
-- (no table rewrite), taking ACCESS EXCLUSIVE on "PaymentTransaction" for the
-- catalog change alone, inside this short DDL-only transaction. No index,
-- constraint, trigger or foreign key is added.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "hadIssuedXeroInvoice" BOOLEAN;

COMMIT;
