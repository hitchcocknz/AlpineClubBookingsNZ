/**
 * #4070: the answers an own-card edit refund can get from
 * `refundPaymentTransactions` after the edit commits, and what the "Booking
 * Modified" email must then say. Shared by the four edit doors' tests so each
 * door is driven through the same states. `queued` is whether what is still
 * owed goes to the recovery runner (`enqueueBookingModificationRefundRecovery`):
 * only a call that throws queues anything.
 *
 * `primeOwnCardRefund` answers a `refundPaymentTransactions` double with the
 * state's refunds, or rejects with its error.
 */
import type { Mock } from "vitest";

import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";

type Answer = { refunds: Array<{ refundId: string; paymentIntentId: string; amountCents: number; status: string | null }> } | Error;

const made = (status: string | null): Answer => ({
  refunds: [{ refundId: "re_own_1", paymentIntentId: "pi_original", amountCents: 1000, status }],
});

export const OWN_CARD_REFUND_STATES: ReadonlyArray<{
  label: string;
  answer: Answer;
  queued: boolean;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "Stripe answered succeeded", answer: made("succeeded"), queued: false, destination: "own" },
  { label: "Stripe answered pending", answer: made("pending"), queued: false, destination: "own" },
  // A refund with no status counts as made, as the organiser executor counts it (`status ?? "unknown"`).
  { label: "Stripe answered no status", answer: made(null), queued: false, destination: "own" },
  { label: "the Stripe call throws", answer: new Error("stripe down"), queued: true, destination: "own_card_pending" },
  { label: "Stripe answered failed", answer: made("failed"), queued: false, destination: "own_card_pending" },
  { label: "no refund came back", answer: { refunds: [] }, queued: false, destination: "own_card_pending" },
];

export function primeOwnCardRefund(refundPaymentTransactions: Mock, answer: Answer): void {
  if (answer instanceof Error) refundPaymentTransactions.mockRejectedValue(answer);
  else refundPaymentTransactions.mockResolvedValue(answer);
}
