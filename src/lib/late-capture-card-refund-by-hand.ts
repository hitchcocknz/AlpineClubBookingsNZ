import { readUnnotedLateCaptureCardRefundCents } from "@/lib/late-capture-refund-credit-note";
import {
  findLateCapturePaymentIntents,
  readLateCaptureXeroReceipt,
  readPaidAnotherWayLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";

/**
 * #3924 round 12 (`INV-PAY-110`, `INV-PAY-122`): A LATE CAPTURE'S CARD REFUNDS
 * NO NOTE WILL EVER ANSWER, for the repair tool's report-only
 * `LATE_CAPTURE_CARD_REFUND_RECORD_BY_HAND`.
 *
 * Where the two receipt verdicts part: every card-refund path reads the
 * capture's receipt as resolved by hand (`readLateCaptureXeroReceipt`), so it
 * raises no card note, while the app's own invoice is known to be in Xero
 * (`readPaidAnotherWayLateCaptureXeroReceipt` names it - a change linked in
 * Xero, or a row resolved after the app sent it). An officer marking a linked
 * change invoice resolved, as its retry's 409 says to, lands here. Xero then
 * shows the charge received and its card refunds never credited, so what of
 * them no note answers (`readUnnotedLateCaptureCardRefundCents`) is recorded
 * by hand. Main's verdict is deliberately not widened to raise the note
 * instead: rows resolved before #3924 may already have been recorded by hand,
 * and a note would credit them twice.
 *
 * By capture, for the late captures among `paymentIntentIds`
 * (`findLateCapturePaymentIntents`), only where something is left.
 */
export async function readLateCaptureCardRefundsByHand(
  paymentId: string,
  paymentIntentIds: readonly string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const paymentIntentId of await findLateCapturePaymentIntents(paymentIntentIds)) {
    if ((await readLateCaptureXeroReceipt(paymentIntentId)).kind !== "resolved-by-hand") continue;
    const known = await readPaidAnotherWayLateCaptureXeroReceipt(paymentIntentId);
    if (known.kind !== "recorded" || known.invoiceId === null) continue;
    const cents = await readUnnotedLateCaptureCardRefundCents(paymentId, paymentIntentId);
    if (cents > 0) found.set(paymentIntentId, cents);
  }
  return found;
}
