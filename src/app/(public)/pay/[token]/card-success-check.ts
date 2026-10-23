/**
 * #4300 (`INV-PAY-138`): what a card success on the `/pay` link actually did,
 * asked of the server rather than assumed. Stripe's "succeeded" only says money
 * moved: the payment may have settled the booking, or (an intent an edit had
 * superseded) be going back while the booking still owes.
 *
 * First the link's own context: `paid` there is the answer. Otherwise the
 * payment-intent route again: `alreadyPaid` is paid; a fresh secret is the
 * booking still owing, with the going-back notice when the route says so or the
 * paid intent is not the one now pointed at; a known refusal is shown as such.
 * Anything else - a 410 because the webhook settled (or capacity-cancelled) the
 * booking in between, a 429, a network failure - ends in "Payment received -
 * check booking status", never back at the pay buttons.
 */
import {
  PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE,
} from "@/lib/payment-recovery-contract";
import { paymentRecoveryForRefusal, type PaymentLinkContext, type PaymentRecovery } from "./pay-link-presentation";

export type CardSuccessOutcome =
  | { kind: "paid"; context: PaymentLinkContext | null }
  | { kind: "fresh"; clientSecret: string; previousPaymentRefunding: boolean }
  | { kind: "recovery"; recovery: PaymentRecovery };

const STATUS_UNCONFIRMED: CardSuccessOutcome = {
  kind: "recovery",
  recovery: { heading: "Payment received - check booking status", message: PAYMENT_RECEIVED_STATUS_UNCONFIRMED_MESSAGE },
};

export async function checkCardSuccess(token: string, paidIntentId: string): Promise<CardSuccessOutcome> {
  const path = `/api/pay/${encodeURIComponent(token)}`;
  try {
    const contextResponse = await fetch(path);
    if (contextResponse.ok) {
      const context = (await contextResponse.json().catch(() => null)) as PaymentLinkContext | null;
      if (context?.state === "paid") return { kind: "paid", context };
    }
  } catch {
    // Ask the intent route instead.
  }
  try {
    const response = await fetch(`${path}/payment-intent`, { method: "POST" });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const recovery = response.status === 409 ? paymentRecoveryForRefusal(data) : null;
      return recovery ? { kind: "recovery", recovery } : STATUS_UNCONFIRMED;
    }
    if (data.alreadyPaid === true) return { kind: "paid", context: null };
    if (typeof data.clientSecret !== "string" || data.paymentIntentId === paidIntentId) return STATUS_UNCONFIRMED;
    return {
      kind: "fresh",
      clientSecret: data.clientSecret,
      previousPaymentRefunding: data.previousPaymentRefunding === true || data.paymentIntentId !== paidIntentId,
    };
  } catch {
    return STATUS_UNCONFIRMED;
  }
}
