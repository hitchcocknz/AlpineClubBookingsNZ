/**
 * #4218: the read half of "the credit note was spent outside the app" (the pure
 * half is `xero-credit-note-spent-outside-app.ts`).
 */
import logger from "@/lib/logger";
import { getClubFormat } from "@/lib/club-format-settings";
import { exactProviderAmountToCents } from "@/lib/money-provider-amount";
import { formatCents } from "@/lib/utils";
import { failXeroSyncOperation } from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getXeroErrorSearchText,
} from "@/lib/xero-api-client";
import {
  CreditNoteSpentOutsideAppError,
  isCreditNoteOverAllocationText,
  isCreditNoteSpentOutsideAppError,
  noteAllocationCentsForInvoice,
  refusalMeansSpentOutsideApp,
} from "@/lib/xero-credit-note-spent-outside-app";

/**
 * #4218: Xero refused the allocation as larger than the note's remaining credit.
 * That refusal is the verdict, unless a read disproves it
 * (`refusalMeansSpentOutsideApp`). The read also says how much is left, for the
 * message. Read-only, outside any transaction, and best effort with a short
 * budget (no rate-limit waits, so recording the failure is never held up): any
 * failure leaves the amount out and never replaces the error being reported.
 * Null means the refusal is not an outside spend; the caller keeps the original.
 */
export async function describeCreditNoteSpentOutsideApp(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  cause: unknown,
): Promise<CreditNoteSpentOutsideAppError | null> {
  let remainingCents: number | null = null;
  let allocatedToInvoiceCents: number[] = [];
  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
      {
        operation: "getCreditNote",
        resourceType: "CREDIT_NOTE",
        workflow: "allocateCreditNoteToInvoice",
        context: `getCreditNote(${creditNoteId}) after an over-allocation refusal`,
        armTransientBreaker: false,
        maxRetries: 0,
        maxWaitSec: 5,
      },
    );
    const note = response.body.creditNotes?.[0];
    remainingCents = exactProviderAmountToCents(note?.remainingCredit);
    allocatedToInvoiceCents = noteAllocationCentsForInvoice(
      note?.allocations,
      invoiceId,
      exactProviderAmountToCents,
    );
  } catch (readError) {
    logger.warn(
      { err: readError, creditNoteId },
      "Could not read the credit note after an over-allocation refusal; reporting without the amount left",
    );
  }
  if (!refusalMeansSpentOutsideApp({ remainingCents, allocatedToInvoiceCents }, amountCents)) {
    return null;
  }
  let left = "less than this allocation needs";
  if (remainingCents !== null) {
    try {
      left = `only ${formatCents(remainingCents, await getClubFormat())}`;
    } catch (formatError) {
      logger.warn({ err: formatError }, "Could not format the credit-note amount left; using generic wording");
    }
  }
  return new CreditNoteSpentOutsideAppError(
    `The credit note this allocation needs has ${left} left in Xero; it was used outside the app. Retrying will not help until that credit is restored in Xero.`,
    creditNoteId,
    remainingCents,
    amountCents,
    { cause },
  );
}

/**
 * Record an allocation's failure on its operation and return the error to throw:
 * the named error when Xero refused the allocation as more than the note has
 * left and the note was really spent outside the app, else the error untouched.
 */
export async function failAllocation(
  operationId: string,
  error: unknown,
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
): Promise<unknown> {
  const named =
    !isCreditNoteSpentOutsideAppError(error) &&
    isCreditNoteOverAllocationText(getXeroErrorSearchText(error))
      ? await describeCreditNoteSpentOutsideApp(creditNoteId, invoiceId, amountCents, error)
      : null;
  const failure = named ?? error;
  await failXeroSyncOperation(operationId, failure);
  return failure;
}
