/**
 * What the Xero Operations repair of a PARTIAL invoice create records as paid
 * (`xero-operation-retry.ts`): the invoice total read from the stored payloads
 * and, for a primary booking invoice, the cash its create stored (#4010).
 */
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { asArray, asRecord, readNumber } from "@/lib/xero-json";
import { parsePrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-fee-at-link";

/**
 * The invoice's total: Xero's response total, else the sum of the request's
 * lines; null when neither can be read. A supplementary invoice's cash.
 */
export function readStoredInvoiceTotalCents(
  operation: { requestPayload: unknown; responsePayload: unknown },
): number | null {
  const responsePayload = asRecord(operation.responsePayload);
  const invoiceResponse = asRecord(responsePayload?.invoice);
  const responseInvoice = asRecord(asArray(invoiceResponse?.invoices)[0]);
  const responseTotalCents = providerAmountToCents(readNumber(responseInvoice?.total));
  if (responseTotalCents !== null) {
    return responseTotalCents;
  }

  const requestPayload = asRecord(operation.requestPayload);
  const requestInvoice = asRecord(asArray(requestPayload?.invoices)[0]);
  const lineItems = asArray(requestInvoice?.lineItems)
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => Boolean(value));

  if (lineItems.length === 0) {
    return null;
  }

  const totalCents = lineItems.reduce((sum, lineItem) => {
    const quantity = readNumber(lineItem.quantity) ?? 1;
    const unitAmount = readNumber(lineItem.unitAmount);
    if (unitAmount === null) {
      return sum;
    }

    // `unitAmount * quantity` first, then the cents boundary — the same
    // left-to-right evaluation the inline `Math.round(unitAmount * quantity *
    // 100)` performed, so the stored-total comparison is unchanged (#2685).
    const lineTotalCents = providerAmountToCents(unitAmount * quantity);
    return lineTotalCents === null ? sum : sum + lineTotalCents;
  }, 0);

  return totalCents > 0 || lineItems.some((lineItem) => readNumber(lineItem.unitAmount) === 0)
    ? totalCents
    : null;
}

/**
 * The Stripe cash the Xero Operations repair of a PARTIAL primary-invoice
 * create records (#4010): the cash the create would have recorded, which it
 * stored with the invoice link. Never the invoice total, which on a card
 * booking with applied account credit overstates the card cash and leaves the
 * credit allocation nothing to settle. An operation written before the figure
 * was stored (see `parsePrimaryInvoiceFeeAtLink`) falls back to the total.
 */
export function primaryInvoiceRepairCashCents(
  requestPayload: unknown,
  xeroInvoiceId: string,
  invoiceTotalCents: number,
): number {
  return parsePrimaryInvoiceFeeAtLink(requestPayload, xeroInvoiceId)?.primaryInvoiceCashCents ?? invoiceTotalCents;
}
