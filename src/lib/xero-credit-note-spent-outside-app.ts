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

/**
 * This note's allocations to one invoice, as exact cents. An allocation whose
 * amount is not an exact cent figure is skipped.
 */
export function noteAllocationCentsForInvoice(
  allocations:
    | ReadonlyArray<{ invoice?: { invoiceID?: string } | null; amount?: unknown }>
    | null
    | undefined,
  invoiceId: string,
  toCents: (amount: unknown) => number | null,
): number[] {
  return (allocations ?? []).flatMap((allocation) => {
    if (allocation.invoice?.invoiceID !== invoiceId) return [];
    const cents = toCents(allocation.amount);
    return cents === null ? [] : [cents];
  });
}

/**
 * Xero refused the allocation as too large. Is that really "spent outside the
 * app"? Not when the follow-up read disproves it, which keeps this signal free of
 * false positives (the ledger convergence in #4219 will act on it):
 *
 * - the note already holds an allocation to this invoice of at least the slice:
 *   that is the app's own earlier success (its completion was never recorded, or
 *   Xero's duplicate-request window had passed), not an outside spend;
 * - the note now shows at least the slice remaining: the credit was restored
 *   between the refusal and the read, so there is nothing to name.
 *
 * With no read to go on (`remainingCents` null, no allocations), Xero's refusal
 * stands.
 */
export function refusalMeansSpentOutsideApp(
  observation: { remainingCents: number | null; allocatedToInvoiceCents: readonly number[] },
  requestedCents: number,
): boolean {
  if (observation.allocatedToInvoiceCents.some((cents) => cents >= requestedCents)) {
    return false;
  }
  if (observation.remainingCents !== null && observation.remainingCents >= requestedCents) {
    return false;
  }
  return true;
}
