/**
 * #4219 — the ledger record that a credit note was spent in Xero outside the app.
 *
 * A written-down lot must not look free again. A lot's remaining balance is its
 * amount less the slices drawn from it (`MemberCreditNoteAllocation`); an outside
 * spend draws no slice for any booking, so it is recorded as a negative
 * `ADMIN_ADJUSTMENT` row for the member, stamped with the note's id. This module
 * is the one definition of such a row: the converge routine writes it and
 * `gatherAppliedCreditLots` subtracts it (`INV-SSOT`).
 */
import { CreditType, Prisma } from "@prisma/client";

export const CREDIT_NOTE_WRITE_DOWN_TYPE = CreditType.ADMIN_ADJUSTMENT;

/** The member's write-down rows for these notes: negative, stamped with a note id. */
export function creditNoteWriteDownWhere(
  memberId: string,
  creditNoteIds: string[],
): Prisma.MemberCreditWhereInput {
  return {
    memberId,
    type: CREDIT_NOTE_WRITE_DOWN_TYPE,
    amountCents: { lt: 0 },
    xeroCreditNoteId: { in: creditNoteIds },
  };
}

/** Total written down per credit note, in positive cents. */
export async function writtenDownCentsByCreditNote(
  db: Pick<Prisma.TransactionClient, "memberCredit">,
  memberId: string,
  creditNoteIds: string[],
): Promise<Map<string, number>> {
  if (creditNoteIds.length === 0) return new Map();
  const rows = await db.memberCredit.groupBy({
    by: ["xeroCreditNoteId"],
    where: creditNoteWriteDownWhere(memberId, creditNoteIds),
    _sum: { amountCents: true },
  });
  return new Map(
    rows.flatMap((row) =>
      row.xeroCreditNoteId ? [[row.xeroCreditNoteId, -(row._sum.amountCents ?? 0)] as const] : [],
    ),
  );
}

export function creditNoteWriteDownDescription(bookingId: string): string {
  return `Credit note used outside the app: credit written down (booking ${bookingId.slice(0, 8)})`;
}

export function creditNoteReleaseDescription(bookingId: string): string {
  return `Applied credit released after booking ${bookingId.slice(0, 8)}'s credit note was used outside the app`;
}
