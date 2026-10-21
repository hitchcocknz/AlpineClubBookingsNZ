/**
 * The figures a primary booking invoice's create stores on its own sync
 * operation when it saves the payment's invoice link (#3955): what the invoice
 * billed, the change fee the payment held at that instant, and the Stripe cash
 * recorded against the invoice (`primaryInvoiceCashCents`), which is capped so
 * the member's applied account credit still fits.
 *
 * One home for the record's types, payload key and reader (`INV-SSOT`). The writer is
 * `persistPrimaryInvoiceLink` (`xero-primary-invoice-fee-gap.ts`); the readers
 * are the change-fee gap check there and the Xero ops panel's PARTIAL repair
 * (`xero-partial-invoice-repair-amount.ts`, #4010). Kept a leaf module so
 * the repair reads the figure without importing the gap check's outbox graph.
 */
import { asRecord } from "@/lib/xero-json";

/** What a primary invoice billed, as the gap check needs it. */
export interface PrimaryInvoiceBilledFee {
  readonly xeroInvoiceId: string;
  /** Its change-fee lines. */
  readonly billedChangeFeeCents: number;
  /** All its lines: what a Stripe payment recorded against it can have settled. */
  readonly billedTotalCents: number;
}

/**
 * What the invoice billed, the fee its payment recorded when the link was
 * saved, and the Stripe cash recorded against the invoice
 * (`primaryInvoiceCashCents`, #3955 round 5, finding 4): computed ONCE by the
 * create and stored with the link, so the gap rule reads the figure the
 * primary's payment was sized at rather than recomputing it from figures that
 * may since have moved.
 */
export interface PrimaryInvoiceFeeAtLink extends PrimaryInvoiceBilledFee {
  readonly recordedChangeFeeCentsAtLink: number;
  readonly primaryInvoiceCashCents: number;
  /**
   * The Stripe payment the create itself tried to write (#4010): the capped
   * figure when it recorded one, else 0. Unlike `primaryInvoiceCashCents` it
   * is never floored at cash the invoice already held, so it is what the
   * PARTIAL repair records. Absent on a record written before it existed.
   */
  readonly primaryInvoiceAttemptedCashCents?: number;
  /**
   * #3980: what the booking was worth, and what the create built, so the gap
   * check measures the whole booking rather than its fee alone. Absent on a
   * record written before #3980, which is checked for its fee only.
   */
  readonly worth?: PrimaryInvoiceWorthAtLink;
}

/**
 * #3980 (`INV-PAY-136`): the booking's worth (`bookingWorthCents`: its
 * `finalPriceCents` plus the recorded change fee) at two instants, and what the
 * create asked Xero to bill.
 *
 *  - `atBuildCents`: the worth the create's own read gave, which its lines were
 *    built from.
 *  - `builtTotalCents`: the total of the lines it sent, promotion and fee
 *    lines included.
 *  - `atLinkCents`: the worth read in the transaction that saves the link,
 *    after the link's row update, so it holds every edit that committed
 *    before the link and none after.
 */
export interface PrimaryInvoiceWorthAtLink {
  readonly atBuildCents: number;
  readonly builtTotalCents: number;
  readonly atLinkCents: number;
  /**
   * #3980 review M5: the edits already marked as settled against the primary
   * invoice in the create's snapshot; one marked since landed mid-create.
   * Absent on a record written before it.
   */
  readonly markedModificationIdsAtBuild?: readonly string[];
}

/**
 * Why a primary invoice records no Stripe cash although the card captured
 * some: its applied account credit takes everything left due. Shared by the
 * create's skip reason and the PARTIAL repair's.
 */
export const PRIMARY_INVOICE_NOTHING_LEFT_DUE_REASON =
  "Nothing is left due on the invoice once its applied account credit is allowed for; no cash is recorded against it.";

/** The create operation's request-payload key the figures are kept under. */
export const PRIMARY_INVOICE_FEE_AT_LINK_KEY = "primaryInvoiceBilledFee";

/**
 * The stored figures for `xeroInvoiceId`, read from a create operation's
 * request payload, or null when the payload holds none for that invoice.
 *
 * Null is how an OLDER operation is recognised: one written before #3955
 * carries no `primaryInvoiceBilledFee` record at all, and one written before
 * its round 5 carries the record without `primaryInvoiceCashCents`. A record
 * for a different invoice is not this invoice's figure and also reads as null.
 * One written before #4010 parses, without `primaryInvoiceAttemptedCashCents`,
 * and one written before #3980 without `worth`.
 */
export function parsePrimaryInvoiceFeeAtLink(
  requestPayload: unknown,
  xeroInvoiceId: string,
): PrimaryInvoiceFeeAtLink | null {
  const record = asRecord(asRecord(requestPayload)?.[PRIMARY_INVOICE_FEE_AT_LINK_KEY]);
  if (
    !record ||
    record.xeroInvoiceId !== xeroInvoiceId ||
    typeof record.billedChangeFeeCents !== "number" ||
    typeof record.billedTotalCents !== "number" ||
    typeof record.recordedChangeFeeCentsAtLink !== "number" ||
    typeof record.primaryInvoiceCashCents !== "number"
  ) {
    return null;
  }
  return {
    xeroInvoiceId,
    billedChangeFeeCents: record.billedChangeFeeCents,
    billedTotalCents: record.billedTotalCents,
    recordedChangeFeeCentsAtLink: record.recordedChangeFeeCentsAtLink,
    primaryInvoiceCashCents: record.primaryInvoiceCashCents,
    ...(typeof record.primaryInvoiceAttemptedCashCents === "number"
      ? { primaryInvoiceAttemptedCashCents: record.primaryInvoiceAttemptedCashCents }
      : {}),
    ...parseWorth(record.worth),
  };
}

function parseWorth(value: unknown): { worth?: PrimaryInvoiceWorthAtLink } {
  const worth = asRecord(value);
  if (
    !worth ||
    typeof worth.atBuildCents !== "number" ||
    typeof worth.builtTotalCents !== "number" ||
    typeof worth.atLinkCents !== "number"
  ) {
    return {};
  }
  const marked = worth.markedModificationIdsAtBuild;
  return {
    worth: {
      atBuildCents: worth.atBuildCents,
      builtTotalCents: worth.builtTotalCents,
      atLinkCents: worth.atLinkCents,
      ...(Array.isArray(marked) && marked.every((id) => typeof id === "string")
        ? { markedModificationIdsAtBuild: marked as string[] }
        : {}),
    },
  };
}
