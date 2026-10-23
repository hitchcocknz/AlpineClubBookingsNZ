import { PaymentSource } from "@prisma/client";

import { cardRefundDoorOf, cardRefundNoteCutoverSeconds, madeSinceCardRefundNoteCutover } from "@/lib/card-refund-own-note-share";
import { noteLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";

/**
 * #4312 (owner decision 24 Oct 2026, `INV-ADDPAY-044`): THE WRITERS' SIDE of a
 * card refund's own note on a bank-transfer payment (the record's side, and
 * the rule, are `card-refund-own-note-share.ts`). Three writers used to fold
 * such a refund into the payment's canonical note; each now asks here:
 *
 * - an approved refund request's card part: the approval, for each refund its
 *   inline attempt made (`queueRefundRequestCardNotes`), and the recovery
 *   replay, for each refund it makes (`refundRequestRecoveryNotesEachRefund`) -
 *   so a refund that did not exist when the approval ran still gets its note;
 * - the `charge.refunded` webhook, for a refund it is the first to record
 *   (`queueWebhookCardRefundNotes`);
 * - a late capture's note (`noteLateCaptureRefunds`), sized per capture.
 *
 * ONLY A REFUND MADE SINCE THE CUTOVER (`madeSinceCardRefundNoteCutover`),
 * and only where it is first known: nothing here walks a payment's older
 * refunds, so a refund an older release folded, or an officer noted by hand,
 * is never given a note (#4287, 22 Oct 2026). Each ask is idempotent - keyed
 * on the refund and sized by what its own notes cover - so two writers asking
 * for one refund raise one note.
 */

/**
 * Queue each named refund's own note, on a bank-transfer payment only: a
 * refund that is counted (`isRecordedRefundStatus`) and made since the
 * cutover. A refund of a late capture is the late-capture note's to size (per
 * capture, against that capture's receipt), so it is handed there. Returns
 * the queued rows. A refund with no row on the payment is skipped. Outside
 * any transaction, as every caller's note enqueue was before.
 */
export async function queueCardRefundOwnNotes(params: {
  paymentId: string;
  stripeRefundIds: readonly string[];
  createdByMemberId?: string;
}): Promise<string[]> {
  const db = prisma;
  const ids = [...new Set(params.stripeRefundIds)];
  if (ids.length === 0) return [];
  const payment = await db.payment.findUnique({ where: { id: params.paymentId }, select: { source: true } });
  if (payment?.source !== PaymentSource.INTERNET_BANKING) return [];
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId: params.paymentId, stripeRefundId: { in: ids } },
    select: { stripeRefundId: true, amountCents: true, status: true, stripePaymentIntentId: true, stripeCreatedAt: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { stripeRefundId: "asc" }],
  });
  const cutoverSeconds = await cardRefundNoteCutoverSeconds(db);
  const qualifying = refunds.filter((refund) => isRecordedRefundStatus(refund.status) && madeSinceCardRefundNoteCutover(refund, cutoverSeconds));
  const lateCaptures = await findLateCapturePaymentIntents(
    qualifying.flatMap((refund) => (refund.stripePaymentIntentId ? [refund.stripePaymentIntentId] : [])),
    db,
  );
  const queued: string[] = [];
  const lateCapturesAsked = new Set<string>();
  for (const refund of qualifying) {
    const intent = refund.stripePaymentIntentId;
    if (intent && lateCaptures.has(intent)) {
      if (!lateCapturesAsked.has(intent)) {
        lateCapturesAsked.add(intent);
        await noteLateCaptureRefunds({ paymentId: params.paymentId, paymentIntentId: intent });
      }
      continue;
    }
    const result = await enqueueXeroRefundCreditNoteOperation(params.paymentId, refund.amountCents, {
      refundMethod: "card",
      cardRefundId: refund.stripeRefundId,
      ...(params.createdByMemberId ? { createdByMemberId: params.createdByMemberId } : {}),
    });
    if (result.queueOperationId) queued.push(result.queueOperationId);
  }
  return queued;
}

/**
 * The approval's note for its card part. On a bank-transfer payment, each
 * refund its inline attempt made gets its own note (a slice the plan marks
 * made, `madeRefundId`); what went to the recovery queue is noted by the
 * replay as it makes it. On any other payment the one note for the card part,
 * exactly as before (`INV-ADDPAY-020`).
 */
export async function queueRefundRequestCardNotes(params: {
  payment: { id: string; source: PaymentSource };
  cardNoteCents: number;
  plan: ReadonlyArray<{ madeRefundId?: string }>;
  createdByMemberId: string;
}): Promise<{ queueOperationId: string | null }> {
  if (params.payment.source !== PaymentSource.INTERNET_BANKING) {
    if (params.cardNoteCents <= 0) return { queueOperationId: null };
    return enqueueXeroRefundCreditNoteOperation(params.payment.id, params.cardNoteCents, { createdByMemberId: params.createdByMemberId });
  }
  const made = params.plan.flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : []));
  const queued = await queueCardRefundOwnNotes({ paymentId: params.payment.id, stripeRefundIds: made, createdByMemberId: params.createdByMemberId });
  return { queueOperationId: queued[0] ?? null };
}

/**
 * The `charge.refunded` webhook's note for what its sync newly recorded. On a
 * card payment, the one per-delta note for the delta, exactly as before. On a
 * bank transfer, each refund this sync is the first to record
 * (`newlyCountedRefundIds`) made since the cutover is sorted by its door
 * (`cardRefundDoorOf`):
 *
 * - made outside the app (the Stripe dashboard): its own note, here - the
 *   webhook is the only writer that ever sees it;
 * - an approved refund request's: nothing here. The approval notes it - its
 *   own note when this release approved it, else the note an older approval
 *   queued for the card part - so a note here could only double it;
 * - any other app door's (a cancellation, an edit, a superseded payment):
 *   left in the delta, which is queued as before. Those doors note their own
 *   refunds, and this delta converges on that note as it always has.
 */
export async function queueWebhookCardRefundNotes(params: {
  payment: { id: string; source: PaymentSource };
  deltaCents: number;
  refunds: ReadonlyArray<{ id: string; amount: number; metadata?: Record<string, string> | null }>;
  newlyCountedRefundIds: readonly string[];
}): Promise<{ queueOperationId: string | null }> {
  if (params.payment.source !== PaymentSource.INTERNET_BANKING) {
    if (params.deltaCents <= 0) return { queueOperationId: null };
    return enqueueXeroRefundCreditNoteOperation(params.payment.id, params.deltaCents);
  }
  const newly = new Set(params.newlyCountedRefundIds);
  const rows = await prisma.paymentRefund.findMany({
    where: { paymentId: params.payment.id, stripeRefundId: { in: [...newly] } },
    select: { stripeRefundId: true, stripeCreatedAt: true, createdAt: true },
  });
  const cutoverSeconds = await cardRefundNoteCutoverSeconds(prisma);
  const sinceCutover = new Set(rows.filter((row) => madeSinceCardRefundNoteCutover(row, cutoverSeconds)).map((row) => row.stripeRefundId));
  const own: string[] = [];
  let answeredElsewhereCents = 0;
  for (const refund of params.refunds) {
    if (!newly.has(refund.id) || !sinceCutover.has(refund.id)) continue;
    const door = cardRefundDoorOf(refund.metadata);
    if (door === "app") continue;
    answeredElsewhereCents += Math.max(0, refund.amount);
    if (door === "outside-app") own.push(refund.id);
  }
  const queued = await queueCardRefundOwnNotes({ paymentId: params.payment.id, stripeRefundIds: own });
  const restCents = params.deltaCents - answeredElsewhereCents;
  if (restCents > 0) {
    const rest = await enqueueXeroRefundCreditNoteOperation(params.payment.id, restCents);
    if (rest.queueOperationId) queued.push(rest.queueOperationId);
  }
  return { queueOperationId: queued[0] ?? null };
}
