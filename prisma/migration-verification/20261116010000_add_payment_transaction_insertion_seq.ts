import type { DataMigrationVerification } from "./types";

/**
 * #4132 (`INV-PAY-133`, owner decision 15 Oct 2026, Option A): every
 * `PaymentTransaction` row gets an `insertionSeq` from an owned INTEGER
 * sequence, and the rows already stored are numbered in the order every reader
 * meets them today - `createdAt`, then the heap order (`ctid`) a tie is
 * returned in - under the migration's own ACCESS EXCLUSIVE lock.
 *
 * What an empty table cannot prove, and this fixture does:
 *
 * 1. A TIE IS NUMBERED IN TODAY'S READ ORDER, NOT BY `id`. Three rows written
 *    together share a `createdAt`; A's status is then updated, which writes its
 *    new tuple at the end of the heap, so today's reader meets the tie as
 *    B, C, A. They are numbered B, C, A. Rows with an earlier `createdAt` are
 *    numbered first even when they were inserted later.
 * 2. THE NEXT ROW IS NUMBERED ABOVE EVERY STORED ROW: an INSERT that omits the
 *    column - as a draining old colour's client does - receives max + 1.
 * 3. On a fresh install with no ledger rows, the first row is numbered 1.
 */

const PARTIES = `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "updatedAt"
  ) VALUES (
    'dmv-4132-member', 'dmv-4132@example.invalid', 'x', 'Ledger', 'Order',
    timezone('UTC', statement_timestamp())
  );
  INSERT INTO "Booking" (
    "id", "memberId", "checkIn", "checkOut", "totalPriceCents", "finalPriceCents", "updatedAt"
  ) VALUES (
    'dmv-4132-booking', 'dmv-4132-member', DATE '2026-08-01', DATE '2026-08-03',
    20000, 20000, timezone('UTC', statement_timestamp())
  ), (
    'dmv-4132-booking-2', 'dmv-4132-member', DATE '2026-09-01', DATE '2026-09-03',
    10000, 10000, timezone('UTC', statement_timestamp())
  );
  INSERT INTO "Payment" ("id", "bookingId", "amountCents", "updatedAt")
  VALUES
    ('dmv-4132-payment', 'dmv-4132-booking', 20000, timezone('UTC', statement_timestamp())),
    ('dmv-4132-payment-2', 'dmv-4132-booking-2', 10000, timezone('UTC', statement_timestamp()));
`;

const LEDGER = `
  ${PARTIES}
  -- A, B, C written together: one createdAt, inserted in that order.
  INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "amountCents", "status", "createdAt", "updatedAt")
  VALUES
    ('dmv-4132-a', 'dmv-4132-payment', 'ADDITIONAL', 1000, 'PENDING', TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00'),
    ('dmv-4132-b', 'dmv-4132-payment', 'ADDITIONAL', 2000, 'PENDING', TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00'),
    ('dmv-4132-c', 'dmv-4132-payment', 'ADDITIONAL', 3000, 'PENDING', TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00');
  -- Inserted after them, but stamped earlier.
  INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "amountCents", "status", "createdAt", "updatedAt")
  VALUES
    ('dmv-4132-d', 'dmv-4132-payment', 'PRIMARY', 20000, 'SUCCEEDED', TIMESTAMP '2026-06-01 00:00:00', TIMESTAMP '2026-06-01 00:00:00'),
    ('dmv-4132-e', 'dmv-4132-payment-2', 'PRIMARY', 10000, 'SUCCEEDED', TIMESTAMP '2026-06-10 00:00:00', TIMESTAMP '2026-06-10 00:00:00');
  -- A's status moves (an indexed column): its new tuple goes to the end of the
  -- heap, so today's reader meets the tie as B, C, A.
  UPDATE "PaymentTransaction" SET "status" = 'FAILED' WHERE "id" = 'dmv-4132-a';
`;

/** The stored rows in the order a reader meets them from now on. */
const NUMBERED = `
  SELECT "id", "insertionSeq"
  FROM "PaymentTransaction"
  WHERE "id" LIKE 'dmv-4132-%' AND "id" <> 'dmv-4132-old-client'
  ORDER BY "insertionSeq"
`;

const COLUMN_DEFINITION = `
  SELECT "data_type" AS "dataType", "is_nullable" AS "isNullable", "column_default" AS "columnDefault",
         pg_get_serial_sequence('"PaymentTransaction"', 'insertionSeq') AS "ownedSequence"
  FROM information_schema.columns
  WHERE "table_schema" = current_schema()
    AND "table_name" = 'PaymentTransaction'
    AND "column_name" = 'insertionSeq'
`;

const COLUMN_AFTER = {
  dataType: "integer",
  isNullable: "NO",
  columnDefault: `nextval('"PaymentTransaction_insertionSeq_seq"'::regclass)`,
  ownedSequence: `public."PaymentTransaction_insertionSeq_seq"`,
};

/** A write that names no insertionSeq, as a draining old colour's client makes. */
const OLD_CLIENT_INSERT = (paymentId: string) => `
  INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "amountCents", "createdAt", "updatedAt")
  VALUES ('dmv-4132-old-client', '${paymentId}', 'ADDITIONAL', 500,
          TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00');
`;

const OLD_CLIENT_ROW = `
  SELECT "insertionSeq" FROM "PaymentTransaction" WHERE "id" = 'dmv-4132-old-client'
`;

const verification: DataMigrationVerification = {
  migration: "20261116010000_add_payment_transaction_insertion_seq",
  intent:
    "Add PaymentTransaction.insertionSeq, NOT NULL, defaulted from an owned INTEGER sequence; number every stored row by createdAt, then the heap order a tie is read in today; and set the sequence so the next row is numbered above every stored row.",
  // The migration carries an explicit BEGIN/COMMIT envelope: this mode.
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "a club whose ledger has a tie, one row of it since updated, and rows stamped earlier but inserted later",
      seed: LEDGER,
      afterMigration: OLD_CLIENT_INSERT("dmv-4132-payment"),
      expectations: [
        {
          claim:
            "rows are numbered by createdAt, and a tie in the order today's reader meets it (B, C, A after A's update), never by id",
          sql: NUMBERED,
          rows: [
            { id: "dmv-4132-d", insertionSeq: 1 },
            { id: "dmv-4132-e", insertionSeq: 2 },
            { id: "dmv-4132-b", insertionSeq: 3 },
            { id: "dmv-4132-c", insertionSeq: 4 },
            { id: "dmv-4132-a", insertionSeq: 5 },
          ],
        },
        {
          claim: "an INSERT that omits insertionSeq is numbered above every stored row",
          sql: OLD_CLIENT_ROW,
          rows: [{ insertionSeq: 6 }],
        },
        {
          claim: "the column is an INTEGER, NOT NULL, defaulted from the sequence it owns",
          sql: COLUMN_DEFINITION,
          rows: [COLUMN_AFTER],
        },
      ],
    },
    {
      name: "a fresh install with no ledger rows",
      seed: PARTIES,
      afterMigration: OLD_CLIENT_INSERT("dmv-4132-payment"),
      expectations: [
        {
          claim: "the first row written is numbered 1",
          sql: OLD_CLIENT_ROW,
          rows: [{ insertionSeq: 1 }],
        },
        {
          claim: "the column is an INTEGER, NOT NULL, defaulted from the sequence it owns",
          sql: COLUMN_DEFINITION,
          rows: [COLUMN_AFTER],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "break a createdAt tie by id instead of the heap order it is read in",
      harm:
        "A tie whose rows were updated since is renumbered in cuid order, so a fold, a refund plan or 'the latest ask' picks a different row the moment the release lands - the #4129 failure, made permanent.",
      find: `row_number() OVER (ORDER BY "createdAt", ctid)`,
      replace: `row_number() OVER (ORDER BY "createdAt", "id")`,
    },
    {
      name: "number rows by heap order alone",
      harm:
        "A row stamped earlier but inserted later is numbered after rows it precedes, so the ledger's tiebreak contradicts its own createdAt order.",
      find: `row_number() OVER (ORDER BY "createdAt", ctid)`,
      replace: `row_number() OVER (ORDER BY ctid)`,
    },
    {
      name: "number newest first",
      harm: "Every stored tie is reversed, so the oldest-first fold and the newest-first refund slices swap rows.",
      find: `row_number() OVER (ORDER BY "createdAt", ctid)`,
      replace: `row_number() OVER (ORDER BY "createdAt" DESC, ctid DESC)`,
    },
    {
      name: "start the sequence at the highest stored number, not above it",
      harm:
        "The first row written after the release shares a number with the newest stored row, so a tie between them has no order again.",
      find: `COALESCE((SELECT max("insertionSeq") FROM "PaymentTransaction"), 0) + 1, false)`,
      replace: `COALESCE((SELECT max("insertionSeq") FROM "PaymentTransaction"), 1), false)`,
    },
  ],
};

export default verification;
