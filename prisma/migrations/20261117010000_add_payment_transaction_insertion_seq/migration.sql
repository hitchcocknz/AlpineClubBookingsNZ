BEGIN;

-- #4132 (INV-PAY-133): a monotonic insertion order for the payment capture
-- ledger. Rows written in one transaction share a `createdAt`, and the
-- ledger's readers fold, plan and pick "the latest" row in an order that
-- PostgreSQL leaves unspecified on a tie. Every money read now orders by
-- `createdAt`, then this column.
--
-- ONE TRANSACTION, EXPAND ONLY (owner decision, 15 Oct 2026, Option A):
--   1. ADD COLUMN, nullable, no default: catalog-only, but it takes ACCESS
--      EXCLUSIVE on "PaymentTransaction" and holds it to COMMIT, so no row
--      can be inserted, updated or moved while the rows are numbered below.
--   2. Number every existing row 1..n by `("createdAt", ctid)`. Under that
--      lock `ctid` is the heap order every reader meets a tie in today, so
--      each stored tie keeps the order it is read in now.
--   3. An owned INTEGER sequence, set so its next value is above every
--      numbered row (1 on an empty table).
--   4. SET DEFAULT nextval(...): a draining old colour's INSERT omits the
--      column and receives the next value, exactly as new code does.
--   5. SET NOT NULL, waived by the validator because the same column gets a
--      non-NULL default in this migration (old-code compatible).
--
-- Deliberately NOT Prisma's generated `SERIAL`: a volatile default on ADD
-- COLUMN rewrites the table and numbers rows in an order nobody chose. INTEGER,
-- not BIGINT: Prisma returns a BigInt for BIGINT, which `JSON.stringify`
-- cannot serialise (INV-OPS-001). No index: every reader already narrows by
-- payment, and the column only breaks a tie.
ALTER TABLE "PaymentTransaction" ADD COLUMN "insertionSeq" INTEGER;

UPDATE "PaymentTransaction" AS "row"
SET "insertionSeq" = "ranked"."seq"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "createdAt", ctid) AS "seq"
  FROM "PaymentTransaction"
) AS "ranked"
WHERE "row"."id" = "ranked"."id";

CREATE SEQUENCE "PaymentTransaction_insertionSeq_seq" AS INTEGER OWNED BY "PaymentTransaction"."insertionSeq";

SELECT setval('"PaymentTransaction_insertionSeq_seq"', COALESCE((SELECT max("insertionSeq") FROM "PaymentTransaction"), 0) + 1, false);

ALTER TABLE "PaymentTransaction" ALTER COLUMN "insertionSeq" SET DEFAULT nextval('"PaymentTransaction_insertionSeq_seq"');

ALTER TABLE "PaymentTransaction" ALTER COLUMN "insertionSeq" SET NOT NULL;

COMMIT;
