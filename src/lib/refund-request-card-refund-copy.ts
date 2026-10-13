/**
 * #4117 (`INV-PAY-128`): what is said about an approved appeal's card refund
 * that was not made in full - on the screen, in the approval's toast, on the
 * request's admin notes and in the officers' alert. One home, so the four say
 * the same thing. Plain module: the client page imports it.
 *
 * The part not made splits in two, because a bank transfer for the second
 * could pay the member twice:
 *
 * - refused: Stripe answered `failed` or `canceled`, so it certainly did not
 *   go back;
 * - unanswered: Stripe gave no answer (a timeout, or the app failed to record
 *   what Stripe did), so it may have been made.
 */

/** The part of an approved appeal's card refund not made, split by what is known. */
export interface UnmadeCardRefund {
  refusedCents: number
  unansweredCents: number
}

/** One instruction per part: refund the refused part another way; check Stripe before refunding the other. */
export function unmadeCardRefundInstructions(unmade: UnmadeCardRefund, formatAmount: (cents: number) => string): string {
  const parts: string[] = []
  if (unmade.refusedCents > 0) {
    parts.push(`${formatAmount(unmade.refusedCents)} was refused by Stripe, so it certainly did not go back: refund it another way.`)
  }
  if (unmade.unansweredCents > 0) {
    parts.push(
      `${formatAmount(unmade.unansweredCents)} got no answer from Stripe and may have been made: check the payment in Stripe before refunding it another way.`,
    )
  }
  return parts.join(" ")
}

/** The officers' alert, and the line stamped on the request's admin notes, when no retry could be queued. */
export function cardRefundNotQueuedMessage(unmade: UnmadeCardRefund, formatAmount: (cents: number) => string): string {
  return `This card refund could not be queued for retry. ${unmadeCardRefundInstructions(unmade, formatAmount)}`
}

/** The toast after an approval: "processed" only when the card refund was made in full. */
export function refundAppealApprovedNotice(
  answer: { cardRefundOwedCents: number; cardRefundQueued: boolean } & UnmadeCardRefund,
  formatAmount: (cents: number) => string,
): string {
  if (answer.cardRefundOwedCents <= 0) return "Refund approved and processed"
  if (answer.cardRefundQueued) return `Refund approved; ${formatAmount(answer.cardRefundOwedCents)} is queued for retry`
  return `Refund approved, but its card refund could not be queued for retry. ${unmadeCardRefundInstructions(answer, formatAmount)}`
}

/**
 * What an approved appeal has refunded so far: the approved amount less every
 * part still to go back - by card (queued, dead or not queued) and by bank
 * transfer while this request's own task is open.
 */
export function refundAppealRefundedCents(approvedAmountCents: number, stillOwedCents: number): number {
  return Math.max(0, approvedAmountCents - Math.max(0, stillOwedCents))
}

/** An approved appeal's outstanding parts, as the screen lists them under "Refunded" (`readApprovedAppealOutcomes`). */
export function refundAppealOutstandingLines(
  outcome: {
    cardRefundState?: "made" | "retrying" | "dead" | "not_queued"
    cardRefundOwedCents?: number
    cardRefundRefusedCents?: number
    cardRefundUnansweredCents?: number
    handBackOwedCents?: number
  },
  formatAmount: (cents: number) => string,
): string[] {
  const lines: string[] = []
  const owed = outcome.cardRefundOwedCents ?? 0
  if (owed > 0 && outcome.cardRefundState === "retrying") lines.push(`${formatAmount(owed)} of the card refund is queued for retry.`)
  if (owed > 0 && outcome.cardRefundState === "dead") lines.push(`${formatAmount(owed)} of the card refund is still owed: its retries ran out.`)
  if (owed > 0 && outcome.cardRefundState === "not_queued") {
    lines.push(
      cardRefundNotQueuedMessage(
        { refusedCents: outcome.cardRefundRefusedCents ?? 0, unansweredCents: outcome.cardRefundUnansweredCents ?? 0 },
        formatAmount,
      ),
    )
  }
  if ((outcome.handBackOwedCents ?? 0) > 0) lines.push(`${formatAmount(outcome.handBackOwedCents ?? 0)} is still to be refunded by bank transfer.`)
  return lines
}

