import { PaymentSource } from "@prisma/client";

import { cardRefundDoorOf, cardRefundNoteCutoverSeconds, madeSinceCardRefundNoteCutover } from "@/lib/card-refund-own-note-share";
import { readFailedRefundsAnsweredBy } from "@/lib/card-refund-resend-answer";
import { noteLateCaptureRefunds } from "@/lib/late-capture-refund-credit-note";
import { findLateCapturePaymentIntents } from "@/lib/late-capture-xero-receipt";
import logger from "@/lib/logger";
import { answersBeforeFailure } from "@/lib/refused-card-refund-retry";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";

/**
 * #4312 (owner decision 24 Oct 2026, `INV-ADDPAY-045`): THE WRITERS' SIDE of a
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
 * - any other recovery replay, for each refund it makes that answers a failure
 *   noted on its own record (`answersOwnNotedFailure`, round 6) - the rule
 *   `charge.refunded` applies to the same refund;
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
 * Queue each named refund's own note, on a bank-transfer payment only. Which
 * refunds qualify - counted, and made since the cutover - is the share's one
 * answer (`readCardRefundNoteShare`): a refund that does not asks for nothing.
 * A refund of a late capture is the late-capture note's to size (per capture,
 * against that capture's receipt, `planLateCaptureCardNotes`), so it is handed
 * there. Returns
 * the queued rows. A refund with no row on the payment is skipped. Outside
 * any transaction, as every caller's note enqueue was before.
 */
export async function queueCardRefundOwnNotes(params: {
  paymentId: string;
  stripeRefundIds: readonly string[];
  createdByMemberId?: string;
  /** #3953: the invoice the refunded capture's own receipt paid, which the note names. */
  creditsInvoiceId?: string;
}): Promise<string[]> {
  const db = prisma;
  const ids = [...new Set(params.stripeRefundIds)];
  if (ids.length === 0) return [];
  const payment = await db.payment.findUnique({ where: { id: params.paymentId }, select: { source: true } });
  if (payment?.source !== PaymentSource.INTERNET_BANKING) return [];
  const refunds = await db.paymentRefund.findMany({
    where: { paymentId: params.paymentId, stripeRefundId: { in: ids } },
    select: { stripeRefundId: true, amountCents: true, stripePaymentIntentId: true },
    orderBy: [{ createdAt: "asc" }, { stripeRefundId: "asc" }],
  });
  const lateCaptures = await findLateCapturePaymentIntents(
    refunds.flatMap((refund) => (refund.stripePaymentIntentId ? [refund.stripePaymentIntentId] : [])),
    db,
  );
  const queued: string[] = [];
  const lateCapturesAsked = new Set<string>();
  for (const refund of refunds) {
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
      ...(params.creditsInvoiceId ? { creditsInvoiceId: params.creditsInvoiceId } : {}),
    });
    if (result.queueOperationId) queued.push(result.queueOperationId);
  }
  return queued;
}

/**
 * #4312 review: whether this payment's card refunds are noted each on its own
 * record from now on - a bank transfer, with the cutover marker finished. The
 * approval reads it before it raises its recovery row, so a row marked
 * `notesEachRefund` is never left with no note while the marker is missing.
 */
export async function notesEachCardRefund(payment: { source: PaymentSource }): Promise<boolean> {
  return payment.source === PaymentSource.INTERNET_BANKING && (await cardRefundNoteCutoverSeconds(prisma)) !== Number.POSITIVE_INFINITY;
}

/**
 * The approval's note for its card part. On a bank-transfer payment, each
 * refund its inline attempt made gets its own note (a slice the plan marks
 * made, `madeRefundId`); what went to the recovery queue is noted by the
 * replay as it makes it. On any other payment - or while the cutover marker
 * has not finished, when no refund qualifies - the one note for the card part,
 * exactly as before (`INV-ADDPAY-020`).
 */
export async function queueRefundRequestCardNotes(params: {
  payment: { id: string; source: PaymentSource };
  cardNoteCents: number;
  plan: ReadonlyArray<{ madeRefundId?: string }>;
  createdByMemberId: string;
}): Promise<{ queueOperationId: string | null }> {
  if (!(await notesEachCardRefund(params.payment))) {
    if (params.cardNoteCents <= 0) return { queueOperationId: null };
    return enqueueXeroRefundCreditNoteOperation(params.payment.id, params.cardNoteCents, { createdByMemberId: params.createdByMemberId });
  }
  const made = params.plan.flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : []));
  const queued = await queueCardRefundOwnNotes({ paymentId: params.payment.id, stripeRefundIds: made, createdByMemberId: params.createdByMemberId });
  return { queueOperationId: queued[0] ?? null };
}

/**
 * #4312 review: THE RECOVERY REPLAY OF A REFUND REQUEST'S CARD PART, NOTING
 * EVERY REFUND IT MADE - whatever the replay's own outcome. `run` makes each
 * Stripe call through `send`, which records the refunds that call made the
 * moment it returns or throws - before any work the replay does after it - and
 * the refunds marked made on the row's plan count too. When the approval left
 * the notes to the refunds (`notesEachRefund`), each made refund is asked for
 * once the replay ends - succeeded, a slice refused (the replay then throws to
 * retry it on its next key), or a slice that threw after earlier ones were
 * made (`PartialRefundError`, whose made refunds are read off it the way the
 * replay reads them, `answersBeforeFailure`). Read at the call, not off what
 * the replay finally throws: re-planning the row or alerting after a partial
 * failure can throw an error of its own, which carries no answers. So a refund
 * made on an attempt that fails is noted on that attempt, never left waiting on
 * a retry that may never come. The money has moved, so a note that cannot be
 * queued is logged, never a reason to fail the row; `run`'s error is rethrown.
 *
 * Any other replay (round 6, #4104) asks for those of its refunds that answer
 * a failure noted on its own record (`queueAnsweringRefundNotes`), by the rule
 * `charge.refunded` applies to the same refund - so the two writers never
 * disagree on whether a re-send is noted on its own record or left to the
 * canonical delta.
 */
export async function replayNotingEachRefund<T>(
  input: { paymentId: string; operationId: string; notesEachRefund: boolean; plan: ReadonlyArray<{ madeRefundId?: string }> },
  run: (send: SendNotingRefunds) => Promise<T>,
  queue: typeof queueCardRefundOwnNotes = queueCardRefundOwnNotes,
  queueAnswering: typeof queueAnsweringRefundNotes = queueAnsweringRefundNotes,
): Promise<T> {
  const ids = input.plan.flatMap((slice) => (slice.madeRefundId ? [slice.madeRefundId] : []));
  const made = (refunds: ReadonlyArray<MadeRefund>) => {
    ids.push(...refunds.filter((refund) => !isRefusedRefundStatus(refund.status)).map((refund) => refund.refundId));
  };
  const send: SendNotingRefunds = async (call) => {
    let result;
    try {
      result = await call();
    } catch (err) {
      made(answersBeforeFailure(err)); // the slices answered before a later one threw (`PartialRefundError`), as the replay reads them
      throw err;
    }
    made(result.refunds);
    return result;
  };
  try {
    return await run(send);
  } finally {
    if (ids.length > 0) {
      await (input.notesEachRefund ? queue : queueAnswering)({ paymentId: input.paymentId, stripeRefundIds: ids }).catch((err: unknown) =>
        logger.error({ err, operationId: input.operationId, paymentId: input.paymentId }, "Could not queue the Xero notes of a recovery replay's card refunds (#4312)"),
      );
    }
  }
}

/**
 * #4312 round 6 (#4104): THE ONE RULE for whether a refund an app door made,
 * other than an approved refund request, is noted on its own record: it
 * answers a failed refund that was (`readFailedRefundsAnsweredBy`'s
 * `ownNoted`, the chain behind it included). That note is sized less what the
 * failed refunds' own notes cover, so it raises only what they do not answer.
 * Otherwise the refund stays with the canonical delta. The recovery replay and
 * `charge.refunded` both ask it, so whichever records the refund first, and a
 * replay of either, reach the same answer.
 */
export async function answersOwnNotedFailure(paymentId: string, stripeRefundId: string): Promise<boolean> {
  return (await readFailedRefundsAnsweredBy(prisma, paymentId, stripeRefundId)).ownNoted;
}

/** A replay's made refunds that answer a failure noted on its own record (`answersOwnNotedFailure`), each noted on its own; on a bank transfer only. */
export async function queueAnsweringRefundNotes(params: { paymentId: string; stripeRefundIds: readonly string[] }): Promise<string[]> {
  const payment = await prisma.payment.findUnique({ where: { id: params.paymentId }, select: { source: true } });
  if (payment?.source !== PaymentSource.INTERNET_BANKING) return [];
  const answering: string[] = [];
  for (const id of new Set(params.stripeRefundIds)) if (await answersOwnNotedFailure(params.paymentId, id)) answering.push(id);
  return queueCardRefundOwnNotes({ paymentId: params.paymentId, stripeRefundIds: answering });
}

type MadeRefund = { refundId: string; status?: string | null };
/** One Stripe call of the replay, its refunds recorded as it returns or throws. */
type SendNotingRefunds = <R extends { refunds: ReadonlyArray<MadeRefund> }>(call: () => Promise<R>) => Promise<R>;

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
 * - one sent again for a refund Stripe failed later that was asked for on its
 *   own record (`answersOwnNotedFailure`, the rule the replay applies too):
 *   its own record, where the failed refund's own note answers it - never the
 *   canonical delta, whose payment-wide gap would hand it another refund's
 *   share;
 * - any other app door's: left in the delta, which is queued as before. On a
 *   bank transfer that is a duplicate capture's or a superseded intent's
 *   refund, of money Xero never received, or a card refund Stripe failed
 *   later, sent again, whose failed refund folded; a cancellation or an edit
 *   never refunds one to a card.
 *   Each door records its refund the moment Stripe answers, so this sync is
 *   seldom the first to (ARCHITECTURE, "A later refund folded into the first
 *   note").
 */
export async function queueWebhookCardRefundNotes(params: {
  payment: { id: string; source: PaymentSource };
  deltaCents: number;
  refunds: ReadonlyArray<{ id: string; amount: number; metadata?: Record<string, string> | null }>;
  newlyCountedRefundIds: readonly string[];
  /** #3953: the invoice the refunded capture's own receipt paid, named by every note this queues. */
  creditsInvoiceId?: string;
}): Promise<{ queueOperationId: string | null }> {
  const naming = params.creditsInvoiceId ? [{ creditsInvoiceId: params.creditsInvoiceId }] : [];
  if (params.payment.source !== PaymentSource.INTERNET_BANKING) {
    if (params.deltaCents <= 0) return { queueOperationId: null };
    return enqueueXeroRefundCreditNoteOperation(params.payment.id, params.deltaCents, ...naming);
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
    if (door === "app" && !(await answersOwnNotedFailure(params.payment.id, refund.id))) continue;
    answeredElsewhereCents += Math.max(0, refund.amount);
    if (door !== "refund-request") own.push(refund.id);
  }
  const queued = await queueCardRefundOwnNotes({ paymentId: params.payment.id, stripeRefundIds: own, ...naming[0] });
  const restCents = params.deltaCents - answeredElsewhereCents;
  if (restCents > 0) {
    const rest = await enqueueXeroRefundCreditNoteOperation(params.payment.id, restCents, ...naming);
    if (rest.queueOperationId) queued.push(rest.queueOperationId);
  }
  return { queueOperationId: queued[0] ?? null };
}
