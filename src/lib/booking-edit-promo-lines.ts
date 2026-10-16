/**
 * The promo lines of a booking edit's price breakdown (#4197).
 *
 * The quote's `priceDiffCents` is the new final price less the STORED final
 * price, and the stored final price carries the booking's previous promo
 * adjustment. So the breakdown has to account for that adjustment as well as
 * the new one, or its lines stop adding up to the change the member is shown.
 * Both figures are the ones the total uses: the stored adjustment, and the new
 * adjustment the preview's promotion pass produced.
 *
 * - An in-progress edit carries the stored adjustment over unchanged: no lines.
 * - A code set that is kept unchanged is one net line, omitted when it nets to
 *   nothing.
 * - An adjustment that goes to nothing is a removal, whether the member removed
 *   the code or it lapsed.
 * - A replaced code is two lines: the new one, and the previous one reversed.
 * - A refused code refuses the save, so its preview shows no reversal; the
 *   promo card shows the refusal instead.
 */
export type BreakdownLine = { label: string; amountCents: number };

export function promoBreakdownLines(input: {
  /** An in-progress edit, which re-runs no promotion. */
  carriedOver: boolean;
  /** The preview refused the requested code (`promoValidation.valid === false`). */
  refused: boolean;
  /** The stored codes, joined for display; null when no redemption row names one. */
  storedCodes: string | null;
  storedAdjustmentCents: number;
  /** The codes the preview applied, joined in the same way; null when none applied. */
  appliedCodes: string | null;
  newAdjustmentCents: number;
}): BreakdownLine[] {
  if (input.carriedOver) return [];
  const stored = input.storedCodes ? `promo '${input.storedCodes}'` : "promo adjustment";
  const hadAdjustment = input.storedAdjustmentCents !== 0;

  if (!input.refused && hadAdjustment && input.newAdjustmentCents === 0) {
    return [{ label: `Removed ${stored}`, amountCents: -input.storedAdjustmentCents }];
  }

  if (input.storedCodes !== null && input.appliedCodes === input.storedCodes) {
    const netCents = input.newAdjustmentCents - input.storedAdjustmentCents;
    return netCents === 0
      ? []
      : [{ label: `Promo '${input.storedCodes}' (re-priced)`, amountCents: netCents }];
  }

  const lines: BreakdownLine[] = [];
  if (input.newAdjustmentCents !== 0) {
    lines.push({
      label: input.appliedCodes ? `Promo '${input.appliedCodes}'` : "Promo discount",
      amountCents: input.newAdjustmentCents,
    });
  }
  if (!input.refused && hadAdjustment) {
    lines.push({
      label: `Previous ${stored} reversed`,
      amountCents: -input.storedAdjustmentCents,
    });
  }
  return lines;
}
