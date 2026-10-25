import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";

/**
 * WHY AN UNPAID ADDITIONAL REQUEST EXISTS, and the member- and officer-facing words for it
 * (#4253 release 2, `INV-ADDPAY-048`). Pure: no client, no clock.
 *
 * A payment holds ONE live ask, but that ask can have absorbed the one before it
 * (`carriedAskCents`, `INV-PAY-098`), so a request can be a change the member made, credit
 * that was used elsewhere in the club's accounts, or BOTH after an edit landed on an unpaid
 * release request (the two are merged into one request for the member). The cause is read
 * from the ledger rows, never guessed from the amount, and every surface that words an
 * unpaid request takes its sentence from here so the sentences cannot drift apart.
 */
/** How many of a payment's newest ADDITIONAL rows a surface loads to read the cause from. */
export const ASK_CAUSE_ROWS = 6;

export type AdditionalAskCause = "edit" | "credit-release" | "mixed";

export type AdditionalAskCauseRow = {
  reason: string | null;
  carriedAskCents: number;
  withdrawnAt?: Date | null;
};

/** The one place that says a ledger reason is a credit-release request's. */
export function isCreditReleaseAskReason(reason: string | null | undefined): boolean {
  return reason === CREDIT_RELEASE_ASK_REASON;
}

/**
 * The cause of the request the NEWEST row is, given the payment's ADDITIONAL rows newest
 * first. The newest row's own cause counts; so does each older row a row carried
 * (`carriedAskCents > 0`), followed back one row at a time, because carrying is what folds an
 * earlier request into a later one. An officer-withdrawn row is not carried and ends the walk.
 * No rows reads as an ordinary change, the wording every surface had before.
 */
export function additionalAskCause(rowsNewestFirst: readonly AdditionalAskCauseRow[]): AdditionalAskCause {
  const [newest, ...older] = rowsNewestFirst;
  if (!newest) return "edit";
  let release = isCreditReleaseAskReason(newest.reason);
  let edit = !release;
  let carried = newest.carriedAskCents;
  for (const row of older) {
    if (carried <= 0 || row.withdrawnAt) break;
    if (isCreditReleaseAskReason(row.reason)) release = true;
    else edit = true;
    carried = row.carriedAskCents;
  }
  if (release && edit) return "mixed";
  return release ? "credit-release" : "edit";
}

/**
 * The invoice number a bank transfer may quote for this request, or null where none may be
 * offered (`INV-ADDPAY-049`). A transfer is only closed by the closer when the request is purely
 * the released credit AND carried nothing (`credit-release-ask-close.ts`): one that merged an edit
 * asks for more than the booking's invoice owes, and one that carried an earlier release would be
 * paid by transfer and never closed, with the member then chased and able to pay twice.
 */
export function bankTransferInvoiceFor(
  rowsNewestFirst: readonly AdditionalAskCauseRow[],
  invoiceNumber: string | null | undefined,
): string | null {
  const [newest] = rowsNewestFirst;
  if (!newest || newest.carriedAskCents > 0 || additionalAskCause(rowsNewestFirst) !== "credit-release") return null;
  return invoiceNumber ?? null;
}

const USED_ELSEWHERE = "account credit applied to this booking was used elsewhere in the club's accounts";

/** The sentence an unpaid-request line on the booking timeline uses (owner-approved cause phrase). */
export function timelinePendingDetail(cause: AdditionalAskCause): string {
  if (cause === "credit-release") return "Account credit applied to this booking was used elsewhere in the club's accounts. This amount has not been paid yet.";
  if (cause === "mixed") return `A booking change increased the total, and ${USED_ELSEWHERE}. This amount has not been paid yet.`;
  return "A booking change increased the total. This extra amount has not been paid yet.";
}

/** The timeline line for a request that was paid but whose own row is missing. */
export function timelinePaidDetail(cause: AdditionalAskCause): string {
  if (cause === "credit-release") return "Account credit applied to this booking was used elsewhere in the club's accounts and the payment requested for it succeeded.";
  if (cause === "mixed") return `A booking change increased the total, and ${USED_ELSEWHERE}. The payment requested for both succeeded.`;
  return "A booking change increased the total and the extra payment succeeded.";
}

/**
 * The timeline lines for the OUTCOME of an extra payment (captured, failed). They are read from
 * audit rows that do not carry the cause, and the booking's current cause may not be the one the
 * payment answered, so a request that is not purely a change gets wording that is true of any.
 */
export function timelineCapturedDetail(cause: AdditionalAskCause): string {
  return cause === "edit"
    ? "Extra payment for a booking change was captured successfully."
    : "The extra payment requested for this booking was captured successfully.";
}

export function timelineFailedDetail(cause: AdditionalAskCause, latest = false): string {
  if (cause === "edit") {
    return latest
      ? "The latest extra payment required by a booking change failed."
      : "The extra payment required by a booking change failed.";
  }
  return latest
    ? "The latest extra payment requested for this booking failed."
    : "The extra payment requested for this booking failed.";
}

/**
 * What an officer reads on the booking's additional-payment panel, in the two pieces either side
 * of the amount (the panel puts the figure between them in bold).
 */
export function officerPanelParts(cause: AdditionalAskCause): { lead: string; trail: string } {
  if (cause === "credit-release") return { lead: "Account credit applied to this booking was used elsewhere in the club's accounts, so ", trail: " is owed and has not been collected." };
  if (cause === "mixed") return { lead: `A change to this booking increased the total, and ${USED_ELSEWHERE}; together `, trail: " is owed and has not been collected." };
  return { lead: "A change to this booking increased the total by ", trail: ", and that amount has not been collected." };
}

/** The officer panel sentence as plain text; `amount` is already formatted. */
export function officerPanelSentence(cause: AdditionalAskCause, amount: string): string {
  const { lead, trail } = officerPanelParts(cause);
  return `${lead}${amount}${trail}`;
}

/**
 * The member's payment card when its form could not load, in the two pieces either side of the
 * amount (the card puts the figure between them in bold).
 */
export function memberCardFallbackParts(cause: AdditionalAskCause): { lead: string; trail: string } {
  const trail = " is still owing on this booking according to our records.";
  if (cause === "credit-release") return { lead: "Account credit applied to your booking was used elsewhere in the club's accounts, so ", trail };
  if (cause === "mixed") return { lead: "A recent booking change, and account credit applied to your booking that was used elsewhere in the club's accounts, mean ", trail };
  return { lead: "A recent booking modification means ", trail };
}

/** The member card fallback as plain text; `amount` is already formatted. */
export function memberCardFallbackSentence(cause: AdditionalAskCause, amount: string): string {
  const { lead, trail } = memberCardFallbackParts(cause);
  return `${lead}${amount}${trail}`;
}

/**
 * The paragraph above the member's payment form, in the two pieces either side of the amount.
 */
export function memberCardLeadParts(cause: AdditionalAskCause): { lead: string; trail: string } {
  if (cause === "credit-release") return { lead: "Account credit applied to your booking was used elsewhere in the club's accounts, so ", trail: " is still owing on this booking. Please complete payment below." };
  if (cause === "mixed") return { lead: "A recent booking change, and account credit applied to your booking that was used elsewhere in the club's accounts, mean ", trail: " is still owing on this booking. Please complete payment below." };
  return { lead: "A recent booking modification means ", trail: " is still owing on this booking. Please complete payment to finalise the modification." };
}

/** The pre-arrival reminder's outstanding-amount note; `amount` is already formatted. */
export function preArrivalOutstandingNote(cause: AdditionalAskCause, amount: string): string {
  if (cause === "credit-release") return `There is still ${amount} to pay on this booking because account credit applied to it was used elsewhere in the club's accounts. Please pay it from your booking page before you arrive.`;
  if (cause === "mixed") return `There is still ${amount} to pay on this booking after a change to your stay and because account credit applied to it was used elsewhere in the club's accounts. Please pay it from your booking page before you arrive.`;
  return `There is still ${amount} to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.`;
}
