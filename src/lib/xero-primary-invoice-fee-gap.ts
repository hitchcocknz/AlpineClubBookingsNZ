/**
 * #3955 review X4 and #3980 (`INV-PAY-119`): the primary invoice bills the
 * booking as the create read it - its guests, promotion lines and the change
 * fee recorded on the payment - but it is built before Xero is asked for
 * anything, and its link is saved seconds later. Two things can leave it
 * billing something other than what the booking is worth:
 *
 *  - an edit that read no invoice link and committed while the create was in
 *    flight - an ordinary edit, a guest add or removal, an acceptance re-price,
 *    or a finished-stay correction (its lines were already built); and
 *  - a lost response retried under the same idempotency key, which makes Xero
 *    hand back the ORIGINAL invoice whatever the retry's payload now says.
 *
 * THE FIGURES ARE TAKEN AT THE LINK (#3955 round 4, finding 1). The gap is
 * measured from what the booking was worth AT THE MOMENT its invoice link was
 * saved, never from what it is worth later: an edit after the link reads the
 * link and bills or credits its own change on its own document, so counting it
 * here would bill it twice. {@link persistPrimaryInvoiceLink} saves the link,
 * reads the fee back from that same row update and the booking's worth after
 * it, and records them on the create operation in ONE transaction. The
 * update's row lock orders it against every edit's claim on the payment row
 * (`claimPrimaryInvoiceStillUnlinked`, `recordFinishedStayFeeOwed`): an edit
 * that claimed first is in the figures, one that claims after is refused.
 *
 * RETRY-SAFE (#3955 round 3, finding 2). A run that dies after the link is
 * saved is re-driven through the create's "invoice already exists" exit, which
 * re-runs the check from the stored figures alone
 * ({@link recheckPrimaryInvoiceWorthGap}). A gap already queued on one of its
 * anchors is not queued again, and a task already raised is not raised again.
 */
import { PaymentSource } from "@prisma/client";
import type { Invoice, LineItem, Payment as XeroPayment } from "xero-node";

import { bookingWorthCents, hasCapturedPayment, recordedChangeFeeCents } from "@/lib/booking-payment-state";
import { FEE_ON_PRIMARY_INVOICE_PATH } from "@/lib/booking-finished-stay-correction";
import { SETTLED_AGAINST_PRIMARY_INVOICE_PATH } from "@/lib/booking-primary-invoice-claim";
import { raisePrimaryInvoiceReviewTask } from "@/lib/xero-primary-invoice-review-task";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { buildXeroBookingInvoiceCorrelationKey } from "@/lib/xero-booking-invoice-key";
import { asRecord } from "@/lib/xero-json";
import {
  parsePrimaryInvoiceFeeAtLink,
  PRIMARY_INVOICE_FEE_AT_LINK_KEY,
  type PrimaryInvoiceBilledFee,
  type PrimaryInvoiceFeeAtLink,
} from "@/lib/xero-primary-invoice-fee-at-link";
import {
  CHANGE_FEE_LINE_DESCRIPTION,
  invoiceLineItemsTotalCents,
} from "@/lib/xero-modification-line-items";
import { unallocatedAppliedCents } from "@/lib/xero-applied-credit-ledger-state";
import { isCreditOnlyCardPayment } from "@/lib/credit-only-card-payment";
import { enqueueXeroSupplementaryInvoiceOperation } from "@/lib/xero-operation-outbox";
import {
  readQueuedOutboxPayload,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { sanitizeForJson } from "@/lib/xero-sync";

/** The change fee an invoice's lines bill: its change-fee lines, as Xero adds them. */
export function billedChangeFeeCents(lineItems: ReadonlyArray<LineItem>): number {
  return invoiceLineItemsTotalCents(
    lineItems.filter((line) => line.description === CHANGE_FEE_LINE_DESCRIPTION),
  );
}

export type { PrimaryInvoiceBilledFee, PrimaryInvoiceFeeAtLink } from "@/lib/xero-primary-invoice-fee-at-link";

export function primaryInvoiceBilledFee(
  xeroInvoiceId: string,
  lineItems: ReadonlyArray<LineItem>,
): PrimaryInvoiceBilledFee {
  return {
    xeroInvoiceId,
    billedChangeFeeCents: billedChangeFeeCents(lineItems),
    billedTotalCents: invoiceLineItemsTotalCents(lineItems),
  };
}

type CardSettlePayment = {
  source: PaymentSource | null;
  status: string;
  amountCents: number;
  refundedAmountCents: number | null;
  creditAppliedCents: number;
};

/**
 * #1641: whether a CARD invoice's settle allocates applied account credit
 * against the primary invoice at all — a card capture with net cash left whose
 * mirror records credit applied, or a $0 credit-only card settle
 * (`isCreditOnlyCardPayment`, #3836), whose credit is all that pays it. False
 * for internet banking (its own outbox op allocates), an uncaptured or
 * refunded-out payment, and a full-price capture (`creditAppliedCents = 0`),
 * which must not allocate. The mirror is the GATE only; how much is allocated
 * is the engine's figure ({@link cardSettleAppliedCreditCents}).
 */
export function cardSettleAllocatesAppliedCredit(payment: CardSettlePayment): boolean {
  if (isCreditOnlyCardPayment(payment)) return true;
  const netCapturedCents = payment.amountCents - (payment.refundedAmountCents ?? 0);
  return (
    payment.source !== PaymentSource.INTERNET_BANKING &&
    hasCapturedPayment(payment) &&
    netCapturedCents > 0 &&
    payment.creditAppliedCents > 0
  );
}

/**
 * #3955 round 4 (finding 3) and round 5 (finding 2): the applied account credit
 * the card settle will allocate against the primary invoice — the allocation
 * engine's OWN figure (`unallocatedAppliedCents`, from the ledger), behind the
 * settle's gate. The primary payment's cash cap reads this, so the cap and the
 * allocation read one source and the allocation always fits.
 */
export async function cardSettleAppliedCreditCents(
  bookingId: string,
  payment: CardSettlePayment,
): Promise<number> {
  if (!cardSettleAllocatesAppliedCredit(payment)) return 0;
  return unallocatedAppliedCents(bookingId, prisma);
}

/**
 * The Stripe cash recorded against the primary invoice: the net capture,
 * capped at what is due once the applied credit the settle allocates there
 * (`cardSettleAppliedCreditCents`) is allowed for — so that allocation always
 * fits (Xero rejects one beyond the amount due). An invoice built before a fee was recorded bills less than cash
 * plus credit; the cash this leaves over is the gap invoice's (finding 3).
 * `amountDueCents` null (Xero sent none) caps at the net capture alone.
 */
export function primaryInvoiceStripeCashCents(input: {
  netCapturedCents: number;
  amountDueCents: number | null;
  appliedCreditCents: number;
}): number {
  if (input.amountDueCents === null) return input.netCapturedCents;
  return Math.max(0, Math.min(input.netCapturedCents, input.amountDueCents - input.appliedCreditCents));
}

/** The reference the primary invoice's Stripe payment is recorded under. */
export function primaryInvoiceStripePaymentReference(stripePaymentIntentId: string | null): string {
  return `Stripe ${stripePaymentIntentId ?? "payment"}`;
}

/**
 * #3955 round 5, finding 4: the Stripe payment an earlier run of this create
 * already recorded against the invoice Xero handed back — found on the
 * invoice's own payments by its reference. A lost response retried under the
 * same idempotency key returns the original invoice; where that shows the
 * payment already taken, the cap can reach zero, and the run records this
 * payment's link rather than skipping it as cash nothing took.
 */
export function existingPrimaryInvoiceStripePayment(
  invoice: Pick<Invoice, "payments">,
  reference: string,
): XeroPayment | null {
  return (
    (invoice.payments ?? []).find(
      (payment) =>
        Boolean(payment.paymentID) &&
        payment.reference === reference &&
        String(payment.status ?? "").toUpperCase() !== "DELETED",
    ) ?? null
  );
}

/**
 * #3955 round 5, finding 3: captured Stripe cash the primary invoice's cap left
 * off it that no gap invoice takes either - or null where every cent is on a
 * document. It stays on the bank side with no Xero document, so the create
 * logs it with both figures and records it on its operation for a treasurer
 * to reconcile. Only a partial cap counts: a cap at zero is its own loud skip.
 */
export function unrecordedPrimaryInvoiceCash(input: {
  netCapturedCents: number;
  primaryInvoiceCashCents: number;
  gapInvoiceCashCents: number;
}): {
  netCapturedCents: number;
  invoicePaymentCents: number;
  gapInvoiceCashCents: number;
  unrecordedCashCents: number;
} | null {
  const { netCapturedCents, primaryInvoiceCashCents, gapInvoiceCashCents } = input;
  const unrecordedCashCents = netCapturedCents - primaryInvoiceCashCents - gapInvoiceCashCents;
  if (primaryInvoiceCashCents <= 0 || primaryInvoiceCashCents >= netCapturedCents || unrecordedCashCents <= 0) {
    return null;
  }
  return { netCapturedCents, invoicePaymentCents: primaryInvoiceCashCents, gapInvoiceCashCents, unrecordedCashCents };
}


/**
 * Saves the payment's invoice link and, in the SAME transaction, records on
 * the create operation what the invoice billed, the fee the payment held at
 * that instant - read back from the link's own row update - and (#3980) what
 * the booking was then worth, read after that update. Either both commit or
 * neither does, so every saved link has its figures, and no later fee or edit
 * can be mistaken for one the invoice should have billed.
 *
 * The update takes the payment's row lock first. An edit that read no invoice
 * link claims that row too (`claimPrimaryInvoiceStillUnlinked`), so it either
 * committed before the update - and the worth read after it holds the edit -
 * or it claims after, finds the link and is refused. The worth is read in a
 * statement after the update, so it sees every edit that committed first.
 */
export async function persistPrimaryInvoiceLink(input: {
  operationId: string;
  paymentId: string;
  xeroInvoiceNumber: string | null;
  billed: PrimaryInvoiceBilledFee;
  /** #3980: what the create's own read said the booking was worth, and the total of the lines it sent. */
  built: { worthCents: number; lineTotalCents: number };
  /** The Stripe cash recorded against this invoice, computed once by the create. */
  primaryInvoiceCashCents: number;
  /** The Stripe payment the create itself tried to write: what a repair records (#4010). */
  primaryInvoiceAttemptedCashCents: number;
}): Promise<PrimaryInvoiceFeeAtLink> {
  return prisma.$transaction(async (tx) => {
    const linked = await tx.payment.update({
      where: { id: input.paymentId },
      data: { xeroInvoiceId: input.billed.xeroInvoiceId, xeroInvoiceNumber: input.xeroInvoiceNumber },
      select: { changeFeeCents: true, bookingId: true },
    });
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: linked.bookingId },
      select: { finalPriceCents: true },
    });
    const atLink: PrimaryInvoiceFeeAtLink = {
      ...input.billed,
      recordedChangeFeeCentsAtLink: recordedChangeFeeCents(linked),
      primaryInvoiceCashCents: input.primaryInvoiceCashCents,
      primaryInvoiceAttemptedCashCents: input.primaryInvoiceAttemptedCashCents,
      worth: {
        atBuildCents: input.built.worthCents,
        builtTotalCents: input.built.lineTotalCents,
        atLinkCents: bookingWorthCents({
          finalPriceCents: booking.finalPriceCents,
          changeFeeCents: linked.changeFeeCents,
        }),
      },
    };
    const operation = await tx.xeroSyncOperation.findUnique({
      where: { id: input.operationId },
      select: { requestPayload: true },
    });
    await tx.xeroSyncOperation.update({
      where: { id: input.operationId },
      data: {
        requestPayload: sanitizeForJson({
          ...(asRecord(operation?.requestPayload) ?? {}),
          [PRIMARY_INVOICE_FEE_AT_LINK_KEY]: atLink,
        }),
      },
    });
    return atLink;
  });
}

async function readPrimaryInvoiceFeeAtLink(
  bookingId: string,
  xeroInvoiceId: string,
): Promise<PrimaryInvoiceFeeAtLink | null> {
  const operation = await prisma.xeroSyncOperation.findFirst({
    where: {
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      correlationKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
      requestPayload: { path: [PRIMARY_INVOICE_FEE_AT_LINK_KEY, "xeroInvoiceId"], equals: xeroInvoiceId },
    },
    orderBy: { createdAt: "desc" },
    select: { requestPayload: true },
  });
  return parsePrimaryInvoiceFeeAtLink(operation?.requestPayload, xeroInvoiceId);
}

/**
 * #3980 (`INV-PAY-119`): how far the primary invoice falls short of what the
 * booking was worth when its link was saved - positive when it bills too
 * little, negative when it bills too much.
 *
 * MEASURED AS WHAT MOVED, NOT AS A RAW DIFFERENCE. The gap is
 *
 *   (worth at the link - worth the create built from)
 *     + (total the create sent - total Xero billed)
 *
 * The first term is every edit that committed after the create read the
 * booking and before the link was saved. The second is a lost response replayed
 * under the same idempotency key, which hands back the ORIGINAL invoice
 * whatever this run sent. Both totals are net of the promotion lines, which
 * are lines on the invoice like any other. Equivalently, it is the worth at the
 * link less what Xero billed, net of how the create's own lines priced the
 * booking it read: a booking whose stored build-up already disagrees with its
 * headline (`reconcileBookingMoney`), or whose promotion line is the build-up
 * figure, bills that difference on every invoice it ever has, and it is not a
 * race; measuring the raw difference would bill it, or raise it as a task, on
 * every such booking.
 *
 * The fee share is the change fee recorded at the link less the fee lines
 * Xero billed: what the gap invoice bills as a fee, the rest as price.
 *
 * A record written before #3980 has no worth figures and is measured on its
 * fee alone, as it was.
 */
export function primaryInvoiceWorthGap(atLink: PrimaryInvoiceFeeAtLink): {
  gapCents: number;
  feeGapCents: number;
  measuredOn: "worth" | "fee";
} {
  const feeGapCents = atLink.recordedChangeFeeCentsAtLink - atLink.billedChangeFeeCents;
  if (!atLink.worth) return { gapCents: feeGapCents, feeGapCents, measuredOn: "fee" };
  const { atBuildCents, builtTotalCents, atLinkCents } = atLink.worth;
  return {
    gapCents: atLinkCents - atBuildCents + (builtTotalCents - atLink.billedTotalCents),
    feeGapCents,
    measuredOn: "worth",
  };
}

export type PrimaryInvoiceWorthGapResult = {
  gapCents: number;
  queueOperationId: string | null;
  /** The gap was already queued by an earlier run of this check. */
  alreadyQueued: boolean;
  /**
   * The Stripe cash the gap invoice records as paid (its whole figure, or
   * nothing): the part of the capture the primary invoice's cap left over that
   * a document takes (#3955 round 5, finding 3).
   */
  cashTakenCents: number;
  /** #3980: the Xero Operations task raised for a gap nothing can bill automatically, or null. */
  reviewOperationId: string | null;
};

const NO_GAP: PrimaryInvoiceWorthGapResult = {
  gapCents: 0,
  queueOperationId: null,
  alreadyQueued: false,
  cashTakenCents: 0,
  reviewOperationId: null,
};

/**
 * The create's "invoice already exists" exit re-runs the check from the
 * figures stored with the link — never the fee or price the booking records
 * now, which may include a later edit billed on that edit's own document.
 *
 * An invoice with no stored figures was linked before this check existed, or
 * outside the create; there is nothing to compare, so nothing is billed. That
 * is loud when the payment records a fee, because such a fee may be unbilled
 * (`INV-PAY-119`'s limit; #3955 round 4, finding 2).
 */
export async function recheckPrimaryInvoiceWorthGap(input: {
  bookingId: string;
  xeroInvoiceId: string;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceWorthGapResult> {
  const atLink = await readPrimaryInvoiceFeeAtLink(input.bookingId, input.xeroInvoiceId);
  if (!atLink) {
    const payment = await prisma.payment.findUnique({
      where: { bookingId: input.bookingId },
      select: { changeFeeCents: true },
    });
    const recordedCents = recordedChangeFeeCents(payment);
    if (recordedCents > 0) {
      logger.warn(
        { bookingId: input.bookingId, xeroInvoiceId: input.xeroInvoiceId, recordedChangeFeeCents: recordedCents },
        "The booking's primary Xero invoice has no figures from its link, so whether it billed what the booking is worth is not checked (#3955 X4, #3980)",
      );
    }
    return NO_GAP;
  }
  return queuePrimaryInvoiceWorthGap({
    bookingId: input.bookingId,
    atLink,
    createdByMemberId: input.createdByMemberId,
  });
}

/**
 * The edits a primary invoice's gap is anchored on: the ones that settled
 * against it, because they read no invoice link and so raised no document of
 * their own. An ordinary edit says so with #3980's marker
 * ({@link SETTLED_AGAINST_PRIMARY_INVOICE_PATH}); a finished-stay correction
 * that routed its fee to the primary invoice says so with #3955's
 * ({@link FEE_ON_PRIMARY_INVOICE_PATH}), which rows written before #3980 carry
 * alone. Newest first.
 */
async function primaryInvoiceGapAnchors(bookingId: string): Promise<string[]> {
  const anchors = await prisma.bookingModification.findMany({
    where: {
      bookingId,
      OR: [
        { newData: { path: [...SETTLED_AGAINST_PRIMARY_INVOICE_PATH], equals: true } },
        { changeFeeCents: { gt: 0 }, newData: { path: [...FEE_ON_PRIMARY_INVOICE_PATH], equals: true } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return anchors.map((anchor) => anchor.id);
}

/**
 * Bills, or hands to the treasurer, the gap between what the booking was worth
 * when the invoice link was saved and what the primary invoice billed
 * ({@link primaryInvoiceWorthGap}) — all from `atLink`, never a fresh read.
 *
 *  - A POSITIVE gap goes on a supplementary invoice anchored on the newest
 *    edit that settled against the primary invoice
 *    ({@link primaryInvoiceGapAnchors}). Such an edit raised no document of its
 *    own, so an invoice anchored on one is this gap's and nothing else's -
 *    which is also how a re-run knows the gap is already queued, and why it
 *    never raises another edit's queued figure. Its lines are the fee share as
 *    a change fee and the rest as price, signed as an edit's are (#1356).
 *  - A NEGATIVE gap, or a positive one no edit explains, raises a Xero
 *    Operations task for the treasurer (`raisePrimaryInvoiceReviewTask`); no
 *    credit note is raised automatically (owner, 21 Oct 2026).
 */
export async function queuePrimaryInvoiceWorthGap(input: {
  bookingId: string;
  atLink: PrimaryInvoiceFeeAtLink;
  createdByMemberId?: string;
}): Promise<PrimaryInvoiceWorthGapResult> {
  const { bookingId, atLink } = input;
  const { gapCents, feeGapCents, measuredOn } = primaryInvoiceWorthGap(atLink);
  const context = {
    bookingId,
    xeroInvoiceId: atLink.xeroInvoiceId,
    measuredOn,
    billedTotalCents: atLink.billedTotalCents,
    billedChangeFeeCents: atLink.billedChangeFeeCents,
    recordedChangeFeeCentsAtLink: atLink.recordedChangeFeeCentsAtLink,
    ...(atLink.worth
      ? {
          worthCentsAtBuild: atLink.worth.atBuildCents,
          builtTotalCents: atLink.worth.builtTotalCents,
          worthCentsAtLink: atLink.worth.atLinkCents,
        }
      : {}),
  };
  if (gapCents === 0) return NO_GAP;

  const raiseReview = async (kind: "OVERBILLED" | "UNDERBILLED", message: string) => {
    logger.error({ ...context, gapCents }, message);
    const review = await raisePrimaryInvoiceReviewTask({
      kind,
      bookingId,
      xeroInvoiceId: atLink.xeroInvoiceId,
      gapCents,
      figures: context,
      createdByMemberId: input.createdByMemberId,
    });
    return { ...NO_GAP, gapCents, reviewOperationId: review.operationId };
  };

  if (gapCents < 0) {
    // An edit lowered what the booking is worth after the create read it, so
    // the invoice bills more than is owed. A credit note is the treasurer's.
    return raiseReview(
      "OVERBILLED",
      "The booking's primary Xero invoice bills more than the booking was worth when its link was saved; a Xero Operations task asks the treasurer to correct it (#3980)",
    );
  }

  const anchorIds = await primaryInvoiceGapAnchors(bookingId);
  if (anchorIds.length === 0) {
    return raiseReview(
      "UNDERBILLED",
      "The booking's primary Xero invoice bills less than the booking was worth when its link was saved, and no edit settled against it to anchor the remainder on; a Xero Operations task asks the treasurer to bill it (#3980)",
    );
  }

  const [earlierOperation, earlierLink] = await Promise.all([
    prisma.xeroSyncOperation.findFirst({
      where: {
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
        localModel: "BookingModification",
        localId: { in: anchorIds },
      },
      select: { id: true, requestPayload: true },
    }),
    prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "BookingModification",
        localId: { in: anchorIds },
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
      },
      select: { id: true },
    }),
  ]);
  if (earlierOperation || earlierLink) {
    // What the earlier run decided the gap invoice takes of the cash, as it queued it.
    const earlier = readQueuedOutboxPayload(earlierOperation?.requestPayload);
    const cashTakenCents =
      earlier?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE && earlier.recordPayment === true
        ? earlier.priceDiffCents + earlier.changeFeeCents
        : 0;
    logger.info(
      { ...context, gapCents, queueOperationId: earlierOperation?.id ?? null },
      "The booking's primary Xero invoice gap is already queued (#3955 X4, #3980)",
    );
    return {
      ...NO_GAP,
      gapCents,
      queueOperationId: earlierOperation?.id ?? null,
      alreadyQueued: true,
      cashTakenCents,
    };
  }

  // Raised UNPAID like any edit's supplementary invoice, unless a captured
  // Stripe payment already holds the money: the cash the primary invoice's
  // payment did not take is the gap's (finding 3). What the primary took is
  // the figure the create sized its payment at and stored with the link
  // (`primaryInvoiceCashCents`, round 5 finding 4) - never recomputed here.
  const payment = await prisma.payment.findUnique({
    where: { bookingId },
    select: {
      source: true,
      status: true,
      amountCents: true,
      refundedAmountCents: true,
    },
  });
  const netCapturedCents = Math.max(0, (payment?.amountCents ?? 0) - (payment?.refundedAmountCents ?? 0));
  const leftOverCashCents = payment ? netCapturedCents - atLink.primaryInvoiceCashCents : 0;
  const recordPayment =
    payment?.source === PaymentSource.STRIPE && hasCapturedPayment(payment) && leftOverCashCents >= gapCents;

  // The fee share as a change fee, the rest as price; the fee share never
  // exceeds the gap, so neither part is negative and the two sum to it.
  const changeFeeCents = Math.min(gapCents, Math.max(0, feeGapCents));
  const queued = await enqueueXeroSupplementaryInvoiceOperation(
    {
      bookingId,
      priceDiffCents: gapCents - changeFeeCents,
      changeFeeCents,
      bookingModificationId: anchorIds[0],
    },
    { createdByMemberId: input.createdByMemberId, recordPayment },
  );
  const outcome = {
    ...context,
    gapCents,
    bookingModificationId: anchorIds[0],
    recordPayment,
    queueOperationId: queued.queueOperationId,
    enqueueOutcome: queued.outcome,
  };
  // No earlier operation on any anchor, so "covers-total" is the fresh one
  // (or a concurrent run's of this same gap, which the enqueue's anchor lock
  // makes the one operation). Anything else bills nothing.
  if (queued.outcome !== "covers-total" || !queued.queueOperationId) {
    logger.error(
      outcome,
      "The booking's primary Xero invoice bills less than the booking was worth at its link, and the supplementary invoice for the remainder was not queued (#3955 X4, #3980)",
    );
    return { ...NO_GAP, gapCents, queueOperationId: queued.queueOperationId };
  }
  logger.warn(
    outcome,
    "The booking's primary Xero invoice was built before the booking last changed; the remainder is billed on a supplementary invoice (#3955 X4, #3980)",
  );
  return {
    ...NO_GAP,
    gapCents,
    queueOperationId: queued.queueOperationId,
    cashTakenCents: recordPayment ? gapCents : 0,
  };
}
