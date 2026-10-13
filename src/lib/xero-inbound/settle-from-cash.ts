/**
 * SETTLE A BANK TRANSFER FROM THE CASH ITS INVOICE COLLECTED (#3979,
 * `INV-PAY-124`).
 *
 * When Xero reports a booking's PRIMARY invoice paid, the inbound settle
 * (`invoice-paid-effects.ts`) records the bank receipt. Before #3979 it kept the
 * figure the PRIMARY `PaymentTransaction` and `Payment.amountCents` were born
 * with, when the Internet Banking payment was first written. No edit path
 * rewrites either one, so an unpaid booking re-priced before its invoice was
 * raised was settled at its OLD price: the ledger's bank receipt was wrong, and
 * so was every refund and credit cap that reads the payment.
 *
 * Owner decision, 13 Oct 2026 (#3979): the receipt is the cash the paid invoice
 * actually collected (`quantifyXeroInvoiceCashCents`), not the amount the booking
 * owes. A price raised after the invoice is billed on a supplementary invoice,
 * which this invoice never collected, so the amount owed would overstate it.
 *
 * This module decides, from the rows the settle already holds under its locks,
 * whether that figure may be written, and words the operator alert when it may
 * not. It moves no money and takes no lock of its own.
 */
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import type { ClubFormat } from "@/lib/club-format";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { formatCents } from "@/lib/utils";
import { findBookingSupplementaryInvoiceIds } from "@/lib/xero-clearing-allocations";

/** The paid invoice's cash, as `quantifyXeroInvoiceCashCents` measures it. */
export type InvoiceCash = { knownCents: number; complete: boolean };

/** Why a settle kept the stored figure instead of the invoice's cash. */
export type CashSettlementRefusal =
  /** The payload's cash could not be read exactly. */
  | "cash-incomplete"
  /** Cash evidence that quantified to nothing (the classifier and quantifier disagree). */
  | "cash-zero"
  /** The invoice matched more than one payment: its cash is not this payment's alone. */
  | "several-payments"
  /** The payment already carries refunded money - on a never-captured payment, an older credit note folded into it. */
  | "refund-history"
  /** Another captured row (a card capture, an addition) already sits on the payment. */
  | "other-capture"
  /** More than one uncaptured Internet Banking PRIMARY row: which one the cash belongs to is not known. */
  | "several-primary-rows"
  /** A second instrument (#3638) already settled the booking: its own alert speaks for it. */
  | "second-instrument";

export type CashSettlementPlan =
  /** The PRIMARY receipt was already captured: a replay, which decides no amount again. */
  | { kind: "replay" }
  | { kind: "rewrite"; amountCents: number }
  | { kind: "keep"; reason: CashSettlementRefusal };

export type CashSettlementTransaction = {
  kind: PaymentTransactionKind;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
};

function isInternetBankingPrimary(row: Pick<CashSettlementTransaction, "kind" | "source">): boolean {
  return row.kind === PaymentTransactionKind.PRIMARY && row.source === PaymentSource.INTERNET_BANKING;
}

/**
 * The one decision (`INV-PAY-124`). It is taken only at the TRANSITION, while
 * no Internet Banking PRIMARY row of the payment is captured; a replay keeps
 * whatever the first settle wrote. The cash is written only when it is a
 * complete, positive figure that belongs to this payment alone: exactly one
 * matched payment, no refund history, no other captured row, at most one
 * uncaptured Internet Banking PRIMARY row, and no second instrument.
 */
export function planInternetBankingCashSettlement(input: {
  paymentStatus: PaymentStatus;
  refundedAmountCents: number;
  transactions: readonly CashSettlementTransaction[];
  cash: InvoiceCash;
  matchedPayments: number;
  secondInstrument: boolean;
}): CashSettlementPlan {
  const primaryRows = input.transactions.filter(isInternetBankingPrimary);
  if (primaryRows.some((row) => isCapturedTransactionStatus(row.status))) {
    return { kind: "replay" };
  }
  if (input.secondInstrument) return { kind: "keep", reason: "second-instrument" };
  if (!input.cash.complete) return { kind: "keep", reason: "cash-incomplete" };
  if (input.cash.knownCents <= 0) return { kind: "keep", reason: "cash-zero" };
  if (input.matchedPayments !== 1) return { kind: "keep", reason: "several-payments" };
  if (
    input.refundedAmountCents > 0 ||
    input.paymentStatus === PaymentStatus.REFUNDED ||
    input.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED
  ) {
    return { kind: "keep", reason: "refund-history" };
  }
  if (
    input.transactions.some(
      (row) => !isInternetBankingPrimary(row) && isCapturedTransactionStatus(row.status),
    )
  ) {
    return { kind: "keep", reason: "other-capture" };
  }
  if (primaryRows.length > 1) return { kind: "keep", reason: "several-primary-rows" };
  return { kind: "rewrite", amountCents: input.cash.knownCents };
}

/** What the settle tells the operators about the figure it recorded, after it commits. */
export type CashSettlementNotice = {
  storedAmountCents: number;
  cash: InvoiceCash;
  /** Set when the settle kept the stored figure although the cash says otherwise. */
  refusal: CashSettlementRefusal | null;
  /** Set when the cash disagrees with what the booking owes (`INV-PAY-119`). */
  owedCents: number | null;
  /** Whether the booking has a supplementary invoice of its own. */
  hasSupplementaryInvoice: boolean;
};

/**
 * Whether a kept figure is worth an alert. Nothing was refused when the stored
 * figure already IS the complete cash of the one payment the invoice matched.
 * A second instrument is never alerted here: #3638 raises its own.
 */
function keptFigureNeedsAlert(
  reason: CashSettlementRefusal,
  storedAmountCents: number,
  cash: InvoiceCash,
  matchedPayments: number,
): boolean {
  if (reason === "second-instrument") return false;
  return !(cash.complete && matchedPayments === 1 && cash.knownCents === storedAmountCents);
}

/**
 * The cross-check, and the notice it and a refusal produce, read inside the
 * settle's transaction at the transition. `bookingAmountOwedCents`
 * (`INV-PAY-119`) never sets the figure; it only says when the cash disagrees
 * with it. A cancelled booking is not asked: its applied credit has gone back,
 * and its late-cash arm alerts on its own. A shortfall on a booking with a
 * supplementary invoice is the expected shape of a price raised after the
 * invoice (`INV-PAY-047`), so it alone does not alert.
 */
export async function readCashSettlementNotice(
  tx: Prisma.TransactionClient,
  input: {
    plan: CashSettlementPlan;
    storedAmountCents: number;
    cash: InvoiceCash;
    matchedPayments: number;
    booking: { id: string; finalPriceCents: number; cancelled: boolean };
    changeFeeCents: number | null;
  },
): Promise<CashSettlementNotice | null> {
  if (input.plan.kind === "replay") return null;
  const refusal =
    input.plan.kind === "keep" &&
    keptFigureNeedsAlert(input.plan.reason, input.storedAmountCents, input.cash, input.matchedPayments)
      ? input.plan.reason
      : null;

  let owedCents: number | null = null;
  let hasSupplementaryInvoice = false;
  if (!input.booking.cancelled && input.cash.complete && input.matchedPayments === 1) {
    const owed = (
      await readBookingAmountOwed(
        {
          id: input.booking.id,
          finalPriceCents: input.booking.finalPriceCents,
          payment: { changeFeeCents: input.changeFeeCents },
        },
        tx,
      )
    ).owedCents;
    if (owed !== input.cash.knownCents) {
      hasSupplementaryInvoice =
        (await findBookingSupplementaryInvoiceIds(input.booking.id, tx)).length > 0;
      const expectedShortfall = hasSupplementaryInvoice && input.cash.knownCents < owed;
      if (!expectedShortfall) owedCents = owed;
    }
  }

  if (refusal === null && owedCents === null) return null;
  return {
    storedAmountCents: input.storedAmountCents,
    cash: input.cash,
    refusal,
    owedCents,
    hasSupplementaryInvoice,
  };
}

const REFUSAL_WORDING: Record<CashSettlementRefusal, string> = {
  "cash-incomplete": "the amount paid could not be read exactly from Xero",
  "cash-zero": "Xero reported the invoice paid in cash but the amount paid came to nothing",
  "several-payments": "the invoice matched more than one payment in the app",
  "refund-history":
    "the payment already records money refunded before it was paid (an older credit note on the invoice)",
  "other-capture": "another payment is already recorded against the booking",
  "several-primary-rows": "the payment carries more than one unpaid bank-transfer record",
  "second-instrument": "a card payment had already settled the booking",
};

/** The operator alert's body. Plain English; every figure through the club's format. */
export function cashSettlementNoticeMessage(notice: CashSettlementNotice, format: ClubFormat): string {
  const cash = notice.cash.complete
    ? formatCents(notice.cash.knownCents, format)
    : `an amount it could not read exactly (its figures come to ${formatCents(notice.cash.knownCents, format)})`;
  const parts: string[] = [];
  if (notice.refusal) {
    parts.push(
      `Xero shows this booking's bank-transfer invoice paid with ${cash}, but the app kept the ${formatCents(notice.storedAmountCents, format)} it had recorded because ${REFUSAL_WORDING[notice.refusal]}. Check the invoice in Xero and correct the payment by hand if the recorded figure is wrong.`,
    );
  }
  if (notice.owedCents !== null) {
    parts.push(
      `The cash Xero shows, ${cash}, is not what the booking owes (${formatCents(notice.owedCents, format)}).${notice.hasSupplementaryInvoice ? " The booking also has a supplementary invoice for a later change." : ""} If the member paid too much, refund or credit the difference; if too little, collect the rest.`,
    );
  }
  return parts.join(" ");
}
