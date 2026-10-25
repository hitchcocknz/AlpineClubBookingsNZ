/**
 * #3403 (owner decision 26 Oct 2026, "follow the money"; `INV-PAY-070`,
 * `INV-PAY-104`): A SUPERSEDED CARD CHANGE'S WAITING SUPPLEMENTARY INVOICE
 * MOVES TO THE REQUEST THAT NOW CARRIES ITS BALANCE.
 *
 * On the card route a change's Xero supplementary invoice waits
 * `WAITING_PAYMENT` on the change's own PaymentIntent and is released only by a
 * capture of that intent. A later request B that supersedes an unpaid ask A
 * carries A's balance (`INV-PAY-098`) and cancels A (`INV-ADDPAY-023`), so
 * nothing could ever release A's invoice: the reaper retired it a day later
 * while B collected the money. Now A's waiting invoice is re-pointed at B, so
 * B's capture releases BOTH invoices, each for its own amount - never folded
 * onto B's invoice. If B is never paid, nothing is invoiced, as for every
 * other card change. If B was already captured when the move happens, the
 * late-capture release runs for B at once.
 *
 * WHO CALLS IT, each holding nothing (no transaction, no advisory key):
 * - the supersede's durable cancel step, both of its terminal branches
 *   (`processCancelPaymentIntentOperation`, and the Stripe webhook's
 *   `completeCanceledSupersededPaymentIntentRecovery`), after A is FAILED and
 *   before the recovery row completes, so a crash replays it;
 * - every superseding minter, after its cancels and before the new client
 *   secret is returned (`cancelSupersededAdditionalIntentsNow` with the new
 *   intent named), which also covers an A whose card was DECLINED - a FAILED
 *   ask is carried but never cancelled again, so the cancel step never runs
 *   for it;
 * - the waiting-invoice reaper, before it retires an invoice whose booking no
 *   longer names its intent: the backstop for a crash between the two above.
 *
 * WHAT MOVES, and what is refused (each refusal leaves the row exactly as it
 * was, to the reaper and the booking-vs-Xero repair pass as before):
 * - the CARRIER is the payment's newest ADDITIONAL card row, PENDING,
 *   PROCESSING or SUCCEEDED and not withdrawn, on a booking that has not ended
 *   (CANCELLED or BUMPED) or been deleted; a caller naming its new intent must
 *   be naming that row;
 * - the SUPERSEDED rows are the FAILED, unwithdrawn ones before it and after
 *   the last captured row - the unpaid chain the carrier's `carriedAskCents`
 *   absorbed. A withdrawn row is a price reduction's (`retireUnpaidAskChain`),
 *   which retires and counts its own invoices;
 * - the INVOICES are supplementary-invoice creates anchored on a booking
 *   change, still `WAITING_PAYMENT` on one of those rows' intents, carrying no
 *   error code and no resolve mark (`INV-INT-025`);
 * - per anchor, under `lockSupplementaryInvoiceAnchor` (the key the enqueue
 *   decides "is an invoice already going out?" under), the anchor must have no
 *   active supplementary-invoice link and no other outstanding operation;
 * - the carrier must cover what would then wait on it: everything naming it
 *   bills at most its `amountCents`, and what bills changes other than its own
 *   (`captureChangeId`) at most its `carriedAskCents`.
 *
 * THE WRITE is a status-guarded `updateMany` (`WAITING_PAYMENT`, the intent it
 * waited on, no error code, no resolve mark), so a row a reduction retired, a
 * capture released or another caller moved in the meantime matches nothing. It
 * records the intent the invoice first waited on
 * (`SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY`, kept through a later move), which
 * is how a reduction still reads the invoice as the superseded row's own money
 * (`supplementaryInvoiceWaitedFirstOn`). One short transaction per anchor holding
 * that one key; no provider call runs inside, and the late-capture release
 * runs after it commits.
 *
 * NOT TOUCHED: an invoice the reaper already retired (`STALE_WAITING_PAYMENT`)
 * on a superseded intent. With these three callers no new one is retired while
 * a live carrier exists; one retired before this change is left to the repair
 * pass's `MISSING_SUPPLEMENTARY_INVOICE`, because a retired row is revived only
 * by a capture of its OWN intent, and widening that to another intent would
 * give the re-queue a second trigger it was never reviewed for.
 */
import { PaymentSource, PaymentStatus, PaymentTransactionKind, type Prisma } from "@prisma/client";

import { isAdditionalAskRetiredBookingStatus } from "@/lib/additional-payment-chase";
import { anchorCaptureHasReceipt, captureChangeId } from "@/lib/additional-capture-receipt-link";
import logger from "@/lib/logger";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { lockSupplementaryInvoiceAnchor } from "@/lib/xero-operation-outbox";
import {
  SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
  supplementaryInvoiceBilledCents,
  supplementaryInvoiceWaitedFirstOn,
} from "@/lib/xero-operation-outbox-payload";
import { OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES } from "@/lib/xero-supplementary-invoice-statuses";
import { releaseXeroSupplementaryInvoiceForCapturedPaymentIntent } from "@/lib/xero-supplementary-invoice-late-capture";

/** The ledger statuses of a carrier the member can still pay, or has paid. */
const LIVE_CARRIER_STATUSES = new Set<PaymentStatus>([
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
  PaymentStatus.SUCCEEDED,
]);

export type SupersededAskInvoiceRefusal =
  | "not-the-carrier"
  | "booking-ended"
  | "invoice-already-linked"
  | "another-invoice-queued"
  | "unreadable-invoice"
  | "carrier-would-overbill"
  | "changed-under-lock";

export type SupersededAskInvoiceCarryResult = {
  /** The request the invoices now wait on, or null when there is none. */
  carrierPaymentIntentId: string | null;
  /** How many waiting invoices were moved onto it by this call. */
  moved: number;
  /** One entry per anchor (or the whole call) left as it was, and why. */
  refusals: Array<{ anchorId: string | null; reason: SupersededAskInvoiceRefusal }>;
  /** True when the carrier was already captured and its late-capture release ran. */
  releasedOnCapturedCarrier: boolean;
};

type LedgerRow = {
  id: string;
  status: PaymentStatus;
  amountCents: number;
  carriedAskCents: number;
  stripePaymentIntentId: string | null;
  withdrawnAt: Date | null;
  bookingModificationId: string | null;
  reason: string | null;
};

const LEDGER_ROW_SELECT = {
  id: true,
  status: true,
  amountCents: true,
  carriedAskCents: true,
  stripePaymentIntentId: true,
  withdrawnAt: true,
  bookingModificationId: true,
  reason: true,
} as const;

const SUPPLEMENTARY_INVOICE_CREATE = {
  direction: "OUTBOUND",
  entityType: "INVOICE",
  operationType: "CREATE",
  queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} as const;

/** The carrier and the superseded rows it carries, read from one payment's ADDITIONAL card ledger. */
export function carrierAndSupersededRows(rows: readonly LedgerRow[]): {
  carrier: LedgerRow | null;
  superseded: LedgerRow[];
} {
  const carrier = rows.at(-1) ?? null;
  if (
    !carrier?.stripePaymentIntentId ||
    carrier.withdrawnAt ||
    !LIVE_CARRIER_STATUSES.has(carrier.status)
  ) {
    return { carrier: null, superseded: [] };
  }
  const before = rows.slice(0, -1);
  let lastCaptured = -1;
  before.forEach((row, index) => {
    if (isCapturedTransactionStatus(row.status)) lastCaptured = index;
  });
  const superseded = before
    .slice(lastCaptured + 1)
    .filter(
      (row) =>
        row.status === PaymentStatus.FAILED &&
        !row.withdrawnAt &&
        row.stripePaymentIntentId !== null &&
        row.stripePaymentIntentId !== carrier.stripePaymentIntentId,
    );
  return { carrier, superseded };
}

async function readAdditionalCardRows(
  store: Pick<Prisma.TransactionClient, "paymentTransaction">,
  paymentId: string,
): Promise<LedgerRow[]> {
  return store.paymentTransaction.findMany({
    where: { paymentId, kind: PaymentTransactionKind.ADDITIONAL, source: PaymentSource.STRIPE },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: LEDGER_ROW_SELECT,
  });
}

function waitingOnIntentsWhere(intentIds: readonly string[]): Prisma.XeroSyncOperationWhereInput {
  return {
    ...SUPPLEMENTARY_INVOICE_CREATE,
    status: "WAITING_PAYMENT",
    localModel: "BookingModification",
    localId: { not: null },
    manuallyResolvedAt: null,
    lastErrorCode: null,
    OR: intentIds.map((intentId) => ({ requestPayload: { path: ["paymentIntentId"], equals: intentId } })),
  };
}

/**
 * Move the waiting supplementary invoices of a payment's superseded card asks
 * onto the request that now carries their balance. Throws only on a database
 * failure; `followSupersededAskInvoicesSafely` is the callers' spelling.
 */
export async function followSupersededAskInvoicesToCarrier({
  paymentId,
  carrierPaymentIntentId,
}: {
  paymentId: string;
  /** A minter names the intent it just wrote; it must still be the payment's newest live row. */
  carrierPaymentIntentId?: string;
}): Promise<SupersededAskInvoiceCarryResult> {
  const result: SupersededAskInvoiceCarryResult = {
    carrierPaymentIntentId: null,
    moved: 0,
    refusals: [],
    releasedOnCapturedCarrier: false,
  };
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { bookingId: true, booking: { select: { status: true, deletedAt: true } } },
  });
  if (!payment) return result;

  const { carrier, superseded } = carrierAndSupersededRows(await readAdditionalCardRows(prisma, paymentId));
  if (!carrier?.stripePaymentIntentId || superseded.length === 0) return result;
  if (carrierPaymentIntentId && carrier.stripePaymentIntentId !== carrierPaymentIntentId) {
    result.refusals.push({ anchorId: null, reason: "not-the-carrier" });
    return result;
  }
  if (isAdditionalAskRetiredBookingStatus(payment.booking.status) || payment.booking.deletedAt) {
    result.refusals.push({ anchorId: null, reason: "booking-ended" });
    return result;
  }

  const supersededIntentIds = superseded.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const waiting = await prisma.xeroSyncOperation.findMany({
    where: waitingOnIntentsWhere(supersededIntentIds),
    select: { localId: true },
  });
  const anchors = [...new Set(waiting.flatMap((row) => (row.localId ? [row.localId] : [])))].sort();
  if (anchors.length === 0) return result;
  result.carrierPaymentIntentId = carrier.stripePaymentIntentId;

  for (const anchorId of anchors) {
    const verdict = await moveAnchorOntoCarrier({
      bookingId: payment.bookingId,
      paymentId,
      anchorId,
      carrierId: carrier.id,
      carrierPaymentIntentId: carrier.stripePaymentIntentId,
    });
    if (verdict.moved > 0) result.moved += verdict.moved;
    else if (verdict.refusal) result.refusals.push({ anchorId, reason: verdict.refusal });
  }

  if (result.moved > 0) {
    // Read AFTER the moves committed: a capture whose own release ran before
    // them could not see these invoices, and its row is committed before that
    // release reads, so either it released them or this read sees it captured.
    // The one release (`INV-PAY-104`) then decides them, outside any lock,
    // exactly as a capture would; a second release finds nothing waiting.
    const now = await prisma.paymentTransaction.findUnique({ where: { id: carrier.id }, select: { status: true } });
    if (now && isCapturedTransactionStatus(now.status)) {
      await releaseXeroSupplementaryInvoiceForCapturedPaymentIntent(carrier.stripePaymentIntentId);
      result.releasedOnCapturedCarrier = true;
    }
    logger.info(
      { paymentId, ...result },
      "Moved a superseded card change's waiting Xero supplementary invoices onto the request that carries its balance (#3403)",
    );
  }
  if (result.refusals.length > 0) {
    logger.warn(
      { paymentId, ...result },
      "A superseded card change's waiting Xero supplementary invoice was left where it was (#3403); the reaper and the booking-vs-Xero repair pass decide it as before",
    );
  }
  return result;
}

/**
 * One anchor's move, in one short transaction holding that anchor's key and
 * nothing else. Everything decided here is re-read under the key.
 */
async function moveAnchorOntoCarrier(input: {
  bookingId: string;
  paymentId: string;
  anchorId: string;
  carrierId: string;
  carrierPaymentIntentId: string;
}): Promise<{ moved: number; refusal: SupersededAskInvoiceRefusal | null }> {
  return prisma.$transaction(async (tx) => {
    await lockSupplementaryInvoiceAnchor(tx, input.anchorId);

    // The ledger again, under the key: a reduction may have withdrawn the rows,
    // a cancel ended the booking, or a newer request superseded the carrier.
    const [rows, booking] = await Promise.all([
      readAdditionalCardRows(tx, input.paymentId),
      tx.booking.findUnique({ where: { id: input.bookingId }, select: { status: true, deletedAt: true } }),
    ]);
    const { carrier, superseded } = carrierAndSupersededRows(rows);
    if (carrier?.id !== input.carrierId || !carrier.stripePaymentIntentId) {
      return { moved: 0, refusal: "changed-under-lock" as const };
    }
    if (!booking || isAdditionalAskRetiredBookingStatus(booking.status) || booking.deletedAt) {
      return { moved: 0, refusal: "booking-ended" as const };
    }
    const supersededIntentIds = superseded.flatMap((row) => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
    if (supersededIntentIds.length === 0) return { moved: 0, refusal: "changed-under-lock" as const };

    const moving = await tx.xeroSyncOperation.findMany({
      where: { ...waitingOnIntentsWhere(supersededIntentIds), localId: input.anchorId },
      select: { id: true, requestPayload: true },
    });
    if (moving.length === 0) return { moved: 0, refusal: null };
    const movingIds = moving.map((operation) => operation.id);

    const linked = await tx.xeroObjectLink.findFirst({
      where: {
        localModel: "BookingModification",
        localId: input.anchorId,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        active: true,
      },
      select: { id: true },
    });
    if (linked) return { moved: 0, refusal: "invoice-already-linked" as const };
    const otherOutstanding = await tx.xeroSyncOperation.findFirst({
      where: {
        ...SUPPLEMENTARY_INVOICE_CREATE,
        localModel: "BookingModification",
        localId: input.anchorId,
        id: { notIn: movingIds },
        status: { in: [...OUTSTANDING_SUPPLEMENTARY_INVOICE_STATUSES] },
      },
      select: { id: true },
    });
    if (otherOutstanding) return { moved: 0, refusal: "another-invoice-queued" as const };

    // NEVER BILL MORE THAN THE CARRIER ASKS FOR. What already names it (any
    // status but CANCELLED: released or sent still billed its money) plus what
    // moves must fit its amount, and what bills changes other than its own
    // must fit the part it carried.
    const movingBilled = moving.map((operation) => supplementaryInvoiceBilledCents(operation.requestPayload));
    if (movingBilled.some((cents) => cents === null)) return { moved: 0, refusal: "unreadable-invoice" as const };
    const onCarrier = await tx.xeroSyncOperation.findMany({
      where: {
        ...SUPPLEMENTARY_INVOICE_CREATE,
        id: { notIn: movingIds },
        status: { not: "CANCELLED" },
        requestPayload: { path: ["paymentIntentId"], equals: carrier.stripePaymentIntentId },
      },
      select: { localId: true, requestPayload: true },
    });
    const onCarrierBilled = onCarrier.map((operation) => ({
      localId: operation.localId,
      cents: supplementaryInvoiceBilledCents(operation.requestPayload),
    }));
    if (onCarrierBilled.some((entry) => entry.cents === null)) return { moved: 0, refusal: "unreadable-invoice" as const };
    const sum = (values: Array<number | null>) => values.reduce<number>((total, cents) => total + (cents ?? 0), 0);
    const movingCents = sum(movingBilled);
    const ownChangeId = captureChangeId(carrier);
    const carriedOnCarrierCents =
      (ownChangeId === input.anchorId ? 0 : movingCents) +
      sum(onCarrierBilled.filter((entry) => entry.localId !== ownChangeId).map((entry) => entry.cents));
    if (
      movingCents + sum(onCarrierBilled.map((entry) => entry.cents)) > carrier.amountCents ||
      (ownChangeId !== null && carriedOnCarrierCents > carrier.carriedAskCents) ||
      (ownChangeId === null && movingCents > carrier.carriedAskCents)
    ) {
      return { moved: 0, refusal: "carrier-would-overbill" as const };
    }

    // A capture already recorded by its own receipt (`INV-PAY-139`) keeps one
    // recorder: the moved invoice then goes out unpaid, as the late-capture
    // re-queue revives one.
    const carrierCaptured = isCapturedTransactionStatus(carrier.status);
    let moved = 0;
    for (const operation of moving) {
      const payload = asRecord(operation.requestPayload) ?? {};
      const firstIntentId = supplementaryInvoiceWaitedFirstOn(payload);
      const unpaid =
        carrierCaptured &&
        payload.recordPayment !== false &&
        (await anchorCaptureHasReceipt(tx, {
          bookingId: input.bookingId,
          bookingModificationId: input.anchorId,
          paymentIntentId: carrier.stripePaymentIntentId,
        }));
      const written = await tx.xeroSyncOperation.updateMany({
        where: {
          id: operation.id,
          status: "WAITING_PAYMENT",
          manuallyResolvedAt: null,
          lastErrorCode: null,
          requestPayload: { path: ["paymentIntentId"], equals: payload.paymentIntentId as string },
        },
        data: {
          requestPayload: {
            ...payload,
            paymentIntentId: carrier.stripePaymentIntentId,
            [SUPPLEMENTARY_INVOICE_PARKED_FROM_KEY]: firstIntentId,
            ...(unpaid ? { recordPayment: false } : {}),
          } as Prisma.InputJsonObject,
        },
      });
      moved += written.count;
    }
    return { moved, refusal: moved > 0 ? null : ("changed-under-lock" as const) };
  });
}

/**
 * `followSupersededAskInvoicesToCarrier` for the callers, which must never
 * fail on it: a supersede's cancel, a minter's secret and the reaper's sweep
 * all stand whatever happens here. A failure is logged; the reaper retries it
 * before it would retire the invoice, and the repair pass reports what is left.
 */
export async function followSupersededAskInvoicesSafely(input: {
  paymentId: string;
  carrierPaymentIntentId?: string;
}): Promise<SupersededAskInvoiceCarryResult | null> {
  try {
    return await followSupersededAskInvoicesToCarrier(input);
  } catch (err) {
    logger.error(
      { err, ...input },
      "Could not move a superseded card change's waiting Xero supplementary invoice onto the request that carries its balance (#3403); the waiting-invoice reaper tries again before it would retire it",
    );
    return null;
  }
}
