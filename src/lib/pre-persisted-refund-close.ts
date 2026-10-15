/**
 * #4126, #4144 (`INV-PAY-130`, `INV-SSOT`): A PRE-PERSISTED DOOR CLOSES ONLY
 * THE ROW IT SENT.
 *
 * Five doors write their card refund's recovery row BEFORE the inline attempt -
 * the cancellation, the edit financial review, the duplicate capture, the
 * capacity race and the treasurer-approved late capture - and close it
 * `SUCCEEDED` once Stripe has made every slice. Between the refund and the
 * close another writer can move the row on: the runner claims it and its
 * attempt fails (Stripe's key-in-use error, say), and a refund Stripe failed
 * later re-plans the slice onto its next key (`card-refund-failed-later.ts`).
 * A close that ignored that would mark the re-planned debt paid, and "Refunds
 * owed" would stop counting it.
 *
 * So the close is a compare-and-set on the plan the door sent:
 *
 * - four doors close an open row still on that plan (`sentPlanRowWhere`). A row
 *   the runner holds on the same plan is closed, which is harmless: its replay
 *   of the same keys is answered with the door's refunds, and only the close
 *   that moved the row writes a record;
 * - the late-capture approval closes only a row still untouched
 *   (`untouchedPrePersistedRowWhere`, #4126), as its record is written by
 *   whichever close moves the row.
 *
 * A close that matches nothing is read back (`reportLostPrePersistedClose`):
 * already closed, or held or re-planned by another writer, is logged and left
 * to the runner; a row still untouched that would not close is an anomaly -
 * logged and alerted to the officers once for the row, naming the refund.
 */
import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { NOBODY_ALERTED, alertPaymentRecoveryOfficers } from "@/lib/payment-recovery-alert";
import { isUntouchedPrePersistedRow } from "@/lib/payment-recovery-constants";
import type { RefundAllocationSlice } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { sentPlanRowWhere, untouchedPrePersistedRowWhere } from "@/lib/refused-card-refund-retry";

type CloseStore = Prisma.TransactionClient | typeof prisma;

/** The one `SUCCEEDED` close of a door's own pre-persisted row, fenced as above. */
export async function closePrePersistedRefundRow({
  idempotencyKey,
  sentPlan,
  untouchedOnly = false,
  store = prisma,
}: {
  idempotencyKey: string;
  /** The plan the door's inline attempt sent. */
  sentPlan: ReadonlyArray<RefundAllocationSlice>;
  /** #4126: close only a row no worker has touched (the late-capture approval). */
  untouchedOnly?: boolean;
  store?: CloseStore;
}): Promise<Prisma.BatchPayload> {
  return store.paymentRecoveryOperation.updateMany({
    where: untouchedOnly ? untouchedPrePersistedRowWhere(idempotencyKey, sentPlan) : sentPlanRowWhere(idempotencyKey, sentPlan),
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      nextRetryAt: null,
      lastError: null,
      processingStartedAt: null,
      succeededAt: new Date(),
    },
  });
}

/** What a lost close is reported with. */
export type LostCloseContext = {
  /** Names the door in the logs and the alert's once-ever key (`<door>-close-lost:<row id>`). */
  door: string;
  /** The refund as the officers' alert names it, e.g. "The approved refund". */
  refundLabel: string;
  idempotencyKey: string;
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  refundId: string | null;
  format: ClubFormat;
  /** Extra fields for the log lines. */
  context?: Record<string, unknown>;
};

/**
 * A door's close, run: `close` says whether THIS close moved the row. Returns
 * true when it did, false when it matched nothing (read back and reported), and
 * null when it threw - logged, and no anomaly: the row is left to the runner's
 * replay. Never throws.
 */
export async function closeDoorRow(close: () => Promise<boolean>, lost: LostCloseContext): Promise<boolean | null> {
  let closed: boolean;
  try {
    closed = await close();
  } catch (err) {
    logger.error(
      { err, ...logContext(lost) },
      `Failed to close the ${lost.door} refund recovery operation after its inline refund was made; the recovery runner will replay the frozen plan idempotently`,
    );
    return null;
  }
  if (!closed) await reportLostPrePersistedClose(lost);
  return closed;
}

function logContext(lost: LostCloseContext): Record<string, unknown> {
  const { bookingId, paymentIntentId, idempotencyKey, refundId } = lost;
  return { ...lost.context, bookingId, paymentIntentId, idempotencyKey, refundId };
}

/**
 * The close matched nothing: read the row back. Closed already, gone, or held or
 * re-planned by another writer is logged and left to its owner - the runner
 * replays it, and a re-planned slice is still owed. A row still untouched (by
 * the reading above, nothing should have moved it) is an anomaly: logged and
 * alerted to the officers once for the row, naming the refund Stripe made, so a
 * person checks it before the runner replays a plan that may no longer name
 * these keys. Best effort, sent once: nothing calls this again, so an alert that
 * reaches nobody is not retried (the error log above it stands). Never throws.
 */
export async function reportLostPrePersistedClose(lost: LostCloseContext): Promise<void> {
  const context = logContext(lost);
  try {
    const row = await prisma.paymentRecoveryOperation.findUnique({
      where: { idempotencyKey: lost.idempotencyKey },
      select: { id: true, status: true, attempts: true },
    });
    if (!row || !isUntouchedPrePersistedRow(row)) {
      logger[row?.status === PaymentRecoveryOperationStatus.SUCCEEDED ? "info" : "warn"](
        { ...context, operationId: row?.id ?? null, status: row?.status ?? null, attempts: row?.attempts ?? null },
        `The ${lost.door} refund was made but its close matched no row on the plan it sent (#4144): left to the recovery runner`,
      );
      return;
    }
    logger.error(
      { ...context, operationId: row.id },
      `The ${lost.door} refund was made but its close lost on a row still untouched (#4126, #4144) - check the recovery operation`,
    );
    const booking = await prisma.booking.findUnique({ where: { id: lost.bookingId }, select: { id: true } });
    if (!booking) {
      logger.warn({ ...context, operationId: row.id }, `Lost ${lost.door} close alert not sent: the booking no longer exists (#4144)`);
      return;
    }
    await sendAdminAlertOnceEver({
      key: `${lost.door}-close-lost:${row.id}`,
      label: `lost ${lost.door} close alert`,
      context: { ...context, operationId: row.id },
      send: async () =>
        (await alertPaymentRecoveryOfficers(
          {
            bookingId: lost.bookingId,
            operationId: row.id,
            amountCents: lost.amountCents,
            paymentIntentId: lost.paymentIntentId,
            errorMessage: `${lost.refundLabel} was made at Stripe (${lost.refundId ?? "refund id unknown"}), but its recovery operation could not be closed. Check the operation before it is retried.`,
          },
          lost.format,
        )) ?? NOBODY_ALERTED,
    });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to check a lost ${lost.door} close (#4144)`);
  }
}
