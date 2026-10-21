import { IMMEDIATE_PAYMENT_BOOKING_STATUSES } from "@/lib/booking-status";

export type BookingPaymentMode = "payment" | "setup";

export interface BookingPaymentFlowState {
  status: string;
  hasNonMembers?: boolean | null;
  // Group booking ORGANISER_PAYS: the organiser settles this booking, so the
  // joiner who owns it must never be offered a self-pay flow.
  organiserSettled?: boolean | null;
}

function normalizeBookingState(
  booking: string | BookingPaymentFlowState
): BookingPaymentFlowState {
  return typeof booking === "string" ? { status: booking } : booking;
}

export function requiresSavedPaymentMethod(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);
  return state.status === "PENDING" && state.hasNonMembers !== false;
}

export function canCreateImmediatePaymentIntent(
  booking: string | BookingPaymentFlowState
) {
  const state = normalizeBookingState(booking);

  // The organiser settles ORGANISER_PAYS bookings as one combined bill; the
  // joiner who owns the booking is never billed and cannot pay it here.
  if (state.organiserSettled) {
    return false;
  }

  if (requiresSavedPaymentMethod(state)) {
    return false;
  }

  return (IMMEDIATE_PAYMENT_BOOKING_STATUSES as readonly string[]).includes(state.status);
}

export function getBookingPaymentMode(
  booking: string | BookingPaymentFlowState
): BookingPaymentMode {
  return requiresSavedPaymentMethod(booking) ? "setup" : "payment";
}

/**
 * Whether a member whole-lodge approval leaves the payment method to the member
 * (#4019): only when the Internet Banking AND Xero modules are on, because the
 * switch route needs both to mint the receivable and raise the invoice later.
 * With either off the approval keeps its legacy shape. The ONE rule shared by
 * the approval, the request page (which offers the credit election only on
 * this path) and the request route (which records it only on this path).
 */
export function memberWholeLodgeChoosesPaymentMethod(modules: {
  xeroIntegration: boolean;
  internetBankingPayments: boolean;
}): boolean {
  return modules.xeroIntegration === true && modules.internetBankingPayments === true;
}

/**
 * An approved member whole-lodge booking the member has not yet paid (#4019):
 * CONFIRMED and capacity-holding through its whole-lodge hold, with NO Payment
 * row because the approval minted no receivable and no card intent. It owes its
 * price (net of applied credit) exactly as a PAYMENT_PENDING card booking does,
 * so every rule that reprices an unpaid booking - the INV-MOD-012 applied-credit
 * clamp, the $0 auto-settle, the unpaid-finished-stays queue - treats it as one.
 * A CONFIRMED booking WITH a Payment row (a receivable, a captured card) is not.
 */
export function isUnpaidConfirmedWholeLodge(booking: {
  status: string;
  wholeLodgeHold?: boolean | null;
  payment?: { id?: string } | null;
}): boolean {
  return (
    booking.status === "CONFIRMED" &&
    booking.wholeLodgeHold === true &&
    (booking.payment === null || booking.payment === undefined)
  );
}

/**
 * Which unpaid bookings may switch from card to Internet Banking at pay time —
 * the ONE rule the booking page's switch button and the switch route share.
 *
 * - `PAYMENT_PENDING`: the ordinary card booking, as always.
 * - `CONFIRMED` with a whole-lodge hold (#4019): an approved
 *   member whole-lodge booking. Its approval leaves the payment method to the
 *   member, so it is CONFIRMED and capacity-holding through its hold yet owes
 *   its whole price with no receivable minted. Every other CONFIRMED booking
 *   already carries its Internet Banking receivable (school approvals, a card
 *   booking that switched with a bed hold) and is refused by the caller's
 *   "not already Internet Banking" check, not by this rule.
 *
 * The caller still applies its own gates (modules on, not deleted, not
 * organiser-settled, not already Internet Banking, a price to pay).
 */
export function isSwitchableToInternetBanking(booking: {
  status: string;
  wholeLodgeHold?: boolean | null;
}): boolean {
  if (booking.status === "PAYMENT_PENDING") return true;
  return booking.status === "CONFIRMED" && booking.wholeLodgeHold === true;
}
