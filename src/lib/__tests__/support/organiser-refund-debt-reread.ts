/**
 * #4057: the five answers an organiser child's edit refund debt can give when
 * `runOrganiserChildRefundDebtNow` re-reads it after the run, and what the
 * "Booking Modified" email must then say. Shared by the four edit doors' tests
 * so each door is driven through the same states.
 *
 * `primeOrganiserRefundDebt` answers a `paymentRecoveryOperation.findUnique`
 * double: the door's lookup by the edit's key finds the debt, and the re-read
 * by id gives the state's answer. Every other lookup answers null.
 */
import { PaymentRecoveryOperationStatus } from "@prisma/client";
import type { Mock } from "vitest";

import type { BookingModifiedRefundDestination } from "@/lib/booking-modified-email-copy";
import { buildOrganiserChildModificationRefundKey } from "@/lib/payment-recovery-keys";

type Reread = { status: PaymentRecoveryOperationStatus } | null | Error;

export const ORGANISER_REFUND_DEBT_STATES: ReadonlyArray<{
  label: string;
  reread: Reread;
  destination: BookingModifiedRefundDestination;
}> = [
  { label: "SUCCEEDED", reread: { status: PaymentRecoveryOperationStatus.SUCCEEDED }, destination: "organiser_card" },
  { label: "PENDING", reread: { status: PaymentRecoveryOperationStatus.PENDING }, destination: "organiser_card_pending" },
  { label: "FAILED", reread: { status: PaymentRecoveryOperationStatus.FAILED }, destination: "organiser_card_pending" },
  { label: "null (no row on the re-read)", reread: null, destination: "organiser_card_pending" },
  { label: "a re-read that throws", reread: new Error("database blip on the re-read"), destination: "organiser_card_pending" },
];

export function primeOrganiserRefundDebt(
  findUnique: Mock,
  { bookingModificationId, debtId, reread }: { bookingModificationId: string; debtId: string; reread: Reread },
): void {
  const key = buildOrganiserChildModificationRefundKey(bookingModificationId);
  findUnique.mockImplementation(async (args: { where?: { idempotencyKey?: string; id?: string } }) => {
    if (args?.where?.idempotencyKey === key) return { id: debtId };
    if (args?.where?.id === debtId) {
      if (reread instanceof Error) throw reread;
      return reread;
    }
    return null;
  });
}
