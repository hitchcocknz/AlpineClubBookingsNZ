/**
 * #4218 — a credit note the app needs was spent in Xero by something the app did
 * not do (a hand-entered offset, a payment made against the note, a manual
 * allocation).
 *
 * The allocation worker plans from the LOCAL credit ledger and never asks Xero
 * what the note has left, so Xero refuses the allocation with a 400 and every
 * retry sends the same request. This module is the pure half of the fix: the
 * named error and the test for Xero's refusal wording. The Xero read lives with
 * `allocateCreditNoteToInvoice`.
 *
 * Xero's refusal is the trigger, not a read made beforehand. A read can lag an
 * edit made seconds ago, and a stale "low" figure would wrongly fail an
 * allocation Xero would have accepted (and, once the ledger converges from this
 * signal in #4219, wrongly write credit down). Xero's own 400 is the one answer
 * that is authoritative at the moment of the request; the follow-up read only
 * fills in how much is left, for the message.
 *
 * Nothing here writes. The error makes the failure diagnosable; the ledger
 * convergence is #4219.
 */

/** `XeroSyncOperation.lastErrorCode` for this failure (not an HTTP status). */
export const CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE = "CREDIT_NOTE_SPENT_OUTSIDE_APP";

export class CreditNoteSpentOutsideAppError extends Error {
  readonly code = CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE;

  constructor(
    message: string,
    readonly creditNoteId: string,
    /** What Xero says is left, in cents; null when the follow-up read failed. */
    readonly remainingCents: number | null,
    readonly requestedCents: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CreditNoteSpentOutsideAppError";
  }
}

export function isCreditNoteSpentOutsideAppError(
  error: unknown,
): error is CreditNoteSpentOutsideAppError {
  return error instanceof CreditNoteSpentOutsideAppError;
}

/**
 * The `lastErrorCode` an error names for itself, in place of an HTTP status.
 * Null for every other error. The operation stays replayable: a retry sends the
 * allocation again, so it goes through once the credit is restored in Xero.
 */
export function namedXeroErrorCode(error: unknown): string | null {
  return isCreditNoteSpentOutsideAppError(error) ? error.code : null;
}

/**
 * Xero's refusal of an over-allocation: "Credit Note cannot be allocated as the
 * allocation amount is greater than the amount remaining on the Credit Note".
 * Takes the error's search text (`getXeroErrorSearchText`, the one reader of a
 * Xero error's wording).
 */
export function isCreditNoteOverAllocationText(searchText: string): boolean {
  return /allocation amount is greater than the amount remaining on the credit note/i.test(
    searchText,
  );
}
