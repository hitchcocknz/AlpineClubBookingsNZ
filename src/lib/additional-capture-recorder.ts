/**
 * #3953 review round 1 (`INV-PAY-139`): ONE RECORDER PER CAPTURE.
 *
 * Four writers can record a booking's Stripe cash against a Xero invoice: the
 * primary invoice's create, the #3980 gap invoice (paid from the cash the
 * primary left), a booking change's own supplementary invoice, and a change
 * capture's own receipt. Each capture's cash is recorded by exactly one, and
 * every writer knows which captures it took:
 *
 *  - THE PRIMARY'S CREATE records the snapshot's captures, oldest first, while
 *    its recorded cash covers them (`paymentIntentIdsRecordedAtLink`).
 *  - EVERY OTHER CAPTURED CHANGE gets a receipt row as soon as the primary's
 *    link is saved (`queueReceiptsForUnrecordedCaptures`), and later ones as
 *    they land (the late-success release).
 *  - THE GAP INVOICE pays itself only from cash no receipt row has claimed,
 *    and names the captures that cash came from on its own queued payload
 *    (`coveredPaymentIntentIds`, {@link attributeGapCash}).
 *  - A CHANGE'S OWN SUPPLEMENTARY INVOICE - one on the change, or one naming
 *    the capture's intent - is that capture's document.
 *
 * {@link readCaptureRecorder} is the one reading of that: the receipt's
 * enqueue asks it under the per-anchor supplementary-invoice lock, its worker
 * before it plans, and the repair tool before it reports anything.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { CAPTURED_TRANSACTION_STATUS_LIST } from "@/lib/payment-transaction-status";
import { LEDGER_ROWS_OLDEST_FIRST } from "@/lib/payment-ledger-order";
import { XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import {
  GAP_COVERED_INTENTS_KEY,
  XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
} from "@/lib/additional-capture-receipt-payload";
import {
  findPrimaryInvoiceGapInvoice,
  readPrimaryInvoiceFeeAtLink,
  type GapAnchorStore,
} from "@/lib/xero-primary-invoice-gap-anchors";


export type RecorderStore = GapAnchorStore;

export type CaptureRecorder =
  /** The primary invoice's create recorded it in its own payment. */
  | { kind: "primary-invoice" }
  /** A supplementary invoice records it: the change's own, or one naming or covering the intent. */
  | { kind: "supplementary-invoice"; operationId: string | null }
  /**
   * Nothing else does, so the capture's own receipt records it - against the
   * gap invoice only where `gapBillsThisChange`, otherwise the primary.
   */
  | {
      kind: "receipt";
      figures: Awaited<ReturnType<typeof readPrimaryInvoiceFeeAtLink>>;
      /** The primary's gap invoice, whichever change it is anchored on, or null. */
      gap: NonNullable<Awaited<ReturnType<typeof findPrimaryInvoiceGapInvoice>>> | null;
      /** Review round 1 (C): the capture's change is one the gap invoice bills for. */
      gapBillsThisChange: boolean;
    };

export async function readCaptureRecorder(
  input: {
    bookingId: string;
    primaryInvoiceId: string;
    paymentIntentId: string;
    bookingModificationId: string | null;
  },
  store: RecorderStore = prisma,
): Promise<CaptureRecorder> {
  const naming = await store.xeroSyncOperation.findFirst({
    where: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      status: { not: "CANCELLED" },
      OR: [
        { requestPayload: { path: ["paymentIntentId"], equals: input.paymentIntentId } },
        { requestPayload: { path: [GAP_COVERED_INTENTS_KEY], array_contains: [input.paymentIntentId] } },
      ],
    },
    select: { id: true },
  });
  if (naming) return { kind: "supplementary-invoice", operationId: naming.id };

  const figures = await readPrimaryInvoiceFeeAtLink(input.bookingId, input.primaryInvoiceId, store);
  if (figures?.atLink.paymentIntentIdsRecordedAtLink?.includes(input.paymentIntentId)) {
    return { kind: "primary-invoice" };
  }
  const gap = figures ? await findPrimaryInvoiceGapInvoice(input.bookingId, figures, store) : null;
  const modificationId = input.bookingModificationId;
  const gapOfThisChange = gap && modificationId && gap.anchorIds.includes(modificationId) ? gap : null;
  if (modificationId && !gapOfThisChange) {
    // A change the gap does not bill for raised its own invoice, if any: that
    // invoice is this capture's document, whether it records the payment or
    // is the unpaid ask the capture answers.
    const [own, ownLink] = await Promise.all([
      store.xeroSyncOperation.findFirst({
        where: {
          queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
          localModel: "BookingModification",
          localId: modificationId,
          status: { not: "CANCELLED" },
        },
        select: { id: true },
      }),
      store.xeroObjectLink.findFirst({
        where: {
          localModel: "BookingModification",
          localId: modificationId,
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          active: true,
        },
        select: { id: true },
      }),
    ]);
    if (own || ownLink) return { kind: "supplementary-invoice", operationId: own?.id ?? null };
  }
  return { kind: "receipt", figures, gap, gapBillsThisChange: gapOfThisChange !== null };
}

/**
 * The captures whose cash a receipt row has claimed (any status but
 * CANCELLED): the gap invoice never pays itself from those.
 */
export async function readReceiptClaimedIntents(
  bookingId: string,
  store: Pick<Prisma.TransactionClient, "xeroSyncOperation"> = prisma,
): Promise<Set<string>> {
  const rows = await store.xeroSyncOperation.findMany({
    where: {
      queueType: XERO_OUTBOX_ADDITIONAL_CAPTURE_RECEIPT_TYPE,
      status: { not: "CANCELLED" },
      requestPayload: { path: ["bookingId"], equals: bookingId },
    },
    select: { requestPayload: true },
  });
  return new Set(
    rows.flatMap((row) => {
      const id = asRecord(row.requestPayload)?.paymentIntentId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/** The booking's captured Stripe cash, by intent, oldest first: what `attributeGapCash` walks. */
export async function readCapturedStripeCash(
  bookingId: string,
  store: Pick<Prisma.TransactionClient, "paymentTransaction"> = prisma,
): Promise<Array<{ paymentIntentId: string; netCents: number }>> {
  const rows = await store.paymentTransaction.findMany({
    where: {
      payment: { bookingId },
      source: "STRIPE",
      status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] },
      stripePaymentIntentId: { not: null },
    },
    orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
    select: { stripePaymentIntentId: true, amountCents: true, refundedAmountCents: true },
  });
  return rows.flatMap((row) =>
    row.stripePaymentIntentId
      ? [{ paymentIntentId: row.stripePaymentIntentId, netCents: Math.max(0, row.amountCents - row.refundedAmountCents) }]
      : [],
  );
}

/**
 * WHICH CASH THE GAP INVOICE MAY PAY ITSELF FROM, AND WHOSE IT IS. Pure.
 *
 * The captures' net cash, oldest first, less what the primary recorded (taken
 * from the oldest first, as `intentsRecordedByPrimaryCash` reads it) and less
 * every capture a receipt row claimed, is the leftover. The gap takes its
 * whole figure from it, oldest first, or nothing; the captures it takes from
 * are named, with the cents, so their receipts stand down.
 */
export function attributeGapCash(input: {
  captures: ReadonlyArray<{ paymentIntentId: string; netCents: number }>;
  claimed: ReadonlySet<string>;
  primaryCashCents: number;
  gapCents: number;
}): { leftoverCents: number; covered: Array<{ paymentIntentId: string; cents: number }> } {
  let primaryLeft = Math.max(0, input.primaryCashCents);
  const leftover: Array<{ paymentIntentId: string; cents: number }> = [];
  for (const capture of input.captures) {
    const toPrimary = Math.min(primaryLeft, capture.netCents);
    primaryLeft -= toPrimary;
    const rest = capture.netCents - toPrimary;
    if (rest > 0 && !input.claimed.has(capture.paymentIntentId)) {
      leftover.push({ paymentIntentId: capture.paymentIntentId, cents: rest });
    }
  }
  const leftoverCents = leftover.reduce((sum, entry) => sum + entry.cents, 0);
  if (input.gapCents <= 0 || leftoverCents < input.gapCents) return { leftoverCents, covered: [] };
  const covered: Array<{ paymentIntentId: string; cents: number }> = [];
  let need = input.gapCents;
  for (const entry of leftover) {
    if (need <= 0) break;
    const cents = Math.min(need, entry.cents);
    covered.push({ paymentIntentId: entry.paymentIntentId, cents });
    need -= cents;
  }
  return { leftoverCents, covered };
}
