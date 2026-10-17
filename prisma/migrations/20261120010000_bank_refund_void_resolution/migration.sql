-- #4162 (owner decisions 16 and 17 Oct 2026, INV-ADDPAY-042): one row per
-- voided bank-transfer refund credit note the treasurer has answered - recorded
-- again (RE_RECORDED, which queues one fresh note keyed on this row), confirmed
-- cancelled (CONFIRMED_CANCELLED, which takes the refund back out of the
-- payment's records), or confirmed replaced by hand in Xero
-- (CONFIRMED_REPLACED_IN_XERO, which moves nothing). The unique pair is the
-- claim, so a voided note has at most one answer.
--
-- Blue/green EXPAND: a new enum and a new table, no DML. The draining colour
-- never reads or writes either, and no existing table, column or row changes.
-- The only cross-table reference is the Payment foreign key (ON DELETE
-- RESTRICT, as ManualRefundTask's), which only the new colour's rows carry.
--
-- LOCK IMPACT: CREATE TYPE and CREATE TABLE lock only the new objects. The
-- foreign key takes SHARE ROW EXCLUSIVE on "Payment" for the one short
-- DDL-only transaction (it validates nothing: the new table is empty).
--
-- REVERSE: leave the rows in place. Dropping the table would put every answered
-- note back on the treasurer's list.

CREATE TYPE "BankRefundVoidOutcome" AS ENUM ('RE_RECORDED', 'CONFIRMED_CANCELLED', 'CONFIRMED_REPLACED_IN_XERO');

CREATE TABLE "BankRefundVoidResolution" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "voidedCreditNoteId" TEXT NOT NULL,
    "outcome" "BankRefundVoidOutcome" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "resolvedByMemberId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3) NOT NULL,
    "noteOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankRefundVoidResolution_pkey" PRIMARY KEY ("id"),
    -- A resolution records a refund's money: never nothing, never negative.
    CONSTRAINT "BankRefundVoidResolution_amount_positive" CHECK ("amountCents" > 0),
    -- The treasurer's reason is required (owner decision, 17 Oct 2026).
    CONSTRAINT "BankRefundVoidResolution_note_present" CHECK (btrim("note") <> '')
);

CREATE UNIQUE INDEX "BankRefundVoidResolution_paymentId_voidedCreditNoteId_key" ON "BankRefundVoidResolution"("paymentId", "voidedCreditNoteId");

ALTER TABLE "BankRefundVoidResolution" ADD CONSTRAINT "BankRefundVoidResolution_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
