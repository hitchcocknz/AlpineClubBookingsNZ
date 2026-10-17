/**
 * #4210 (`INV-PAY-136`): A CARD REFUND A "PAID ANOTHER WAY" CLOSE ALREADY
 * SETTLED IS NOT OWED AGAIN WHEN STRIPE FAILS IT LATER.
 *
 * A card refund row's runner asks Stripe for refund X and the answer is lost;
 * the treasurer closes the row "Paid another way" and pays the member by bank
 * for what the row still owed - X's share included, because the close never
 * counted X as made. If Stripe then fails X, the member has had that money
 * once, by the close. The failed-later writer (`card-refund-failed-later.ts`)
 * asks this module, under the Payment row lock it holds, before it raises
 * anything; a close takes that lock before it writes its record
 * (`lockPaymentForRefundedTotal`), so the record read here is all or nothing.
 *
 * WHICH CLOSE SETTLED IT. The row that made X decides, never a row it merely
 * fills by amount:
 *
 * - **The row that sent it is known** (`madeBy`, by its runner's metadata):
 *   that row, closed "Paid another way" (its record, `closeKeysOf`), with X
 *   made by Stripe inside its window - by the close (`operationWindowTakes`) -
 *   and not counted by the close: either the app recorded X after the close,
 *   filling that row's slice (the paid-twice reading,
 *   `cardRefundsSentAfterPaidAnotherWay`, through `recordedAfterClose`), or X
 *   fills another row's slice or none, so that row's slice was unfilled when it
 *   closed. A refund made after the close, or one the close counted as made,
 *   is owed again as before.
 * - **No row sent it** - only a refund naming no booking of this payment (made
 *   in the Stripe dashboard, or a legacy group refund): the row whose slice it
 *   fills, by the paid-twice reading alone. A refund another door made for
 *   this booking (an approved refund request's, say) is never settled by
 *   amount: it is owed as before.
 *
 * WHAT IS LEFT FOR AN OFFICER. A full close paid back X's share: nothing is
 * raised. A part close (`paidAnotherWayUnpaidCents`) may have given up X's
 * share: up to what it gave up, `min(X, unpaid)`, is raised dead - attempts
 * spent, never sent - for the treasurer to check. A close whose paid-twice row
 * was marked Resolved (`readPaidTwiceResolution`) most likely had the member
 * return the extra: the whole of X is raised dead. STATED LIMIT: each failed
 * refund is weighed against the close's unpaid part on its own, so two refunds
 * of one part close failing can raise more than it - dead, for a person, never
 * sent.
 */
import { PaymentRecoveryOperationStatus, type PaymentRecoveryOperation, type Prisma } from "@prisma/client";

import { readPaidTwiceResolution } from "@/lib/card-refund-paid-twice-resolution";
import type { PaidAnotherWayFailedLaterOutcome } from "@/lib/card-refund-failed-later-paid-another-way-note";
import { CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, closeKeysOf, paidAnotherWayUnpaidCents } from "@/lib/manual-refund-task-settlement-rules";
import { cardRefundsSentAfterPaidAnotherWay, operationWindowTakes, type CardRefundOwedPaymentRow } from "@/lib/open-card-refund-owed";

/** The close that settled a failed refund, and what it leaves for an officer. */
export type SettlingPaidAnotherWayClose = {
  outcome: PaidAnotherWayFailedLaterOutcome;
  /** The close's record (`ManualRefundTask`) and the row it closed. */
  recordId: string;
  operationId: string;
  paidBackCents: number;
  owedCents: number;
  /** What is raised dead for an officer to check; 0 when settled. */
  checkCents: number;
  /** The refund was counted under "Card refunds paid back twice". */
  onPaidTwiceList: boolean;
  /** The note its paid-twice row was marked Resolved with, if it was. */
  resolutionNote: string | null;
};

/**
 * The "Paid another way" close that settled this failed refund, or null.
 * `beforeFailure` is the payment as it stood before Stripe failed the refund
 * (`cardRefundPaymentBeforeFailure`); `madeBy` the row that sent it; `filledBy`
 * the row whose slice it fills there.
 */
export async function findPaidAnotherWayCloseThatSettled(
  tx: Prisma.TransactionClient,
  {
    rows,
    beforeFailure,
    madeBy,
    filledBy,
    refund,
    bookingId,
  }: {
    rows: ReadonlyArray<PaymentRecoveryOperation>;
    beforeFailure: CardRefundOwedPaymentRow;
    madeBy: string | null;
    filledBy: string | null;
    refund: { id: string; amount: number; metadata?: Record<string, string> | null };
    bookingId: string;
  },
): Promise<SettlingPaidAnotherWayClose | null> {
  const recorded = beforeFailure.refunds.find((each) => each.stripeRefundId === refund.id);
  const closed = (id: string | null) =>
    rows.find((row) => row.id === id && row.status === PaymentRecoveryOperationStatus.SUCCEEDED && row.succeededAt !== null);
  // The row that sent it decides; by amount only a refund no door of this booking made.
  const row = madeBy !== null ? closed(madeBy) : refund.metadata?.bookingId !== bookingId ? closed(filledBy) : undefined;
  if (!recorded || !row) return null;
  const onPaidTwiceList = cardRefundsSentAfterPaidAnotherWay(beforeFailure, new Set([row.id])).get(row.id)?.has(refund.id) === true;
  // Sent by it: made by Stripe by its close, and never counted by that close -
  // recorded after it, or filling another row's slice. Sent by none: the paid-twice reading.
  const settled = madeBy !== null ? operationWindowTakes(row, recorded) && (onPaidTwiceList || filledBy !== row.id) : onPaidTwiceList;
  if (!settled) return null;
  const record = await tx.manualRefundTask.findFirst({
    where: { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, occurrenceKey: { in: closeKeysOf(row.id) } },
    select: { id: true, amountCents: true, raisedAmountCents: true, reviewContext: true },
  });
  if (!record) return null;
  // A resolution speaks only for refunds its paid-twice row listed.
  const resolution = onPaidTwiceList ? readPaidTwiceResolution(record.reviewContext) : null;
  const unpaidCents = paidAnotherWayUnpaidCents(record);
  const checkCents = resolution ? refund.amount : Math.min(refund.amount, unpaidCents);
  return {
    outcome: checkCents === 0 ? "settled-paid-another-way" : resolution ? "raised-check-resolved" : "raised-check-part-close",
    recordId: record.id,
    operationId: row.id,
    paidBackCents: record.amountCents ?? 0,
    owedCents: record.raisedAmountCents ?? record.amountCents ?? 0,
    checkCents,
    onPaidTwiceList,
    resolutionNote: resolution?.note ?? null,
  };
}
