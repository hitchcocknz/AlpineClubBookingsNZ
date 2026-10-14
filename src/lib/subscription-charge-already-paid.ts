import type {
  MembershipFeeBillingBasis,
  MembershipSubscriptionChargeStatus,
} from "@prisma/client";

/**
 * #4098: the one home for what a membership subscription charge's status means
 * for invoice work, and for the "already paid" conflict and its close. Client
 * safe (type imports only): the Subscriptions panel decides which buttons to
 * show from the same predicates the server enforces.
 */

/**
 * The charge statuses that will never need a Xero invoice. `NOT_REQUIRED` is a
 * zero-cent `NO_INVOICE` charge, or one an officer closed because its covered
 * subscriptions were already paid; `VOIDED` is a charge whose invoice Xero voided
 * (#2147). Every delivery consumer — the enqueue, the outbox worker, the outbox
 * failure handler and Xero Operations Retry — leaves these alone.
 */
export const MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES = [
  "NOT_REQUIRED",
  "VOIDED",
] as const satisfies readonly MembershipSubscriptionChargeStatus[];

export function membershipChargeNeedsNoInvoice(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  billingBasis: MembershipFeeBillingBasis | string;
}): boolean {
  return (
    charge.billingBasis === "NO_INVOICE" ||
    (MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES as readonly string[]).includes(charge.status)
  );
}

/** The `lastErrorCode` the invoice worker writes when a covered subscription is already PAID. */
export const SUBSCRIPTION_ALREADY_PAID_CODE = "SUBSCRIPTION_ALREADY_PAID";

/** The longest reason an officer may give for closing an already-paid charge. */
export const CLOSE_ALREADY_PAID_REASON_MAX = 500;

/** How to undo a payment recorded outside the charge, in the panel's words. */
const REVERSE_PAYMENT_HOW = "Mark as unpaid on the subscription, or void it in Xero";

/**
 * What to do with an already-paid conflict whose covered subscriptions are not
 * all paid: it can't be closed as paid. Shared with the close's refusal.
 */
export const PARTLY_PAID_CHARGE_ADVICE =
  "Not every covered subscription is paid, so it can't be closed as paid: " +
  `reverse the payment (${REVERSE_PAYMENT_HOW}) and Retry to invoice the whole charge, ` +
  "or record the remaining payments and then close it.";

/**
 * The conflict message the invoice worker stores, naming the real choices
 * (#4098). The worker conflicts when ANY covered subscription is PAID, but the
 * close needs EVERY one paid, so a partly paid charge gets different advice.
 */
export function subscriptionAlreadyPaidConflictMessage(
  paidMemberNames: readonly string[],
  everyCoveredSubscriptionPaid: boolean,
): string {
  const subject = paidMemberNames.length === 1 ? "subscription is" : "subscriptions are";
  const head = `Covered ${subject} already PAID (${paidMemberNames.join(", ")}); no Xero invoice was created. `;
  if (everyCoveredSubscriptionPaid) {
    return (
      head +
      `Close it as already paid on the Subscriptions page, or reverse the payment (${REVERSE_PAYMENT_HOW}) and Retry.`
    );
  }
  return head + PARTLY_PAID_CHARGE_ADVICE;
}

/**
 * True when an officer may close this charge as already paid: it sits in
 * `CONFLICT` with `SUBSCRIPTION_ALREADY_PAID` and no Xero invoice. The server
 * also re-reads every covered subscription as PAID before it closes.
 */
export function isChargeClosableAsAlreadyPaid(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  lastErrorCode: string | null;
  xeroInvoiceId: string | null;
}): boolean {
  return (
    charge.status === "CONFLICT" &&
    charge.lastErrorCode === SUBSCRIPTION_ALREADY_PAID_CODE &&
    charge.xeroInvoiceId === null
  );
}

/**
 * True for a charge an officer closed as already paid. Confirmation writes
 * `NOT_REQUIRED` only for a `NO_INVOICE` charge, so a `NOT_REQUIRED` charge on
 * any other basis can only have come from the close.
 */
export function isChargeClosedAsAlreadyPaid(charge: {
  status: MembershipSubscriptionChargeStatus | string;
  billingBasis: MembershipFeeBillingBasis | string;
}): boolean {
  return charge.status === "NOT_REQUIRED" && charge.billingBasis !== "NO_INVOICE";
}
