/**
 * #4374 (`INV-INT-029`, `INV-INT-025`): a Xero success that lands on an
 * operation row already resolved in Xero.
 *
 * Two callers can hold one operation row (#1354). One fails, an officer marks
 * the row resolved in Xero and makes the document by hand, and the other
 * caller's own call of the same keyed request then succeeds. The success still
 * lands, links and all - they are real Xero objects - and the mark stays, so
 * Xero may now hold the item twice. Nothing here guards the write: the outcome
 * guard (`xero-operation-outcome-guard.ts`) decides what lands; this only says
 * so, once per operation.
 */
import type { XeroSyncOperation } from "@prisma/client";
import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import logger from "@/lib/logger";
import { isResolvedInXero, resolutionLabel } from "@/lib/xero-operation-resolution";

/** The once-ever claim key of one operation's alert. */
export function xeroSuccessAfterResolutionAlertKey(operationId: string): string {
  return `xero-success-after-resolution:${operationId}`;
}

/**
 * The warning and alert due for a completion's row, or null when none is: the
 * row is SUCCEEDED and carries a resolution mark (`isResolvedInXero`).
 *
 * `operation` must be the row as read after the guarded SUCCEEDED write, in
 * the same transaction: that write holds the row's lock until commit and never
 * changes the mark, so the mark read is the one the success landed on.
 *
 * The answer is a thunk to run after that transaction commits, outside it - it
 * sends an email. It never throws (`sendAdminAlertOnceEver`), and a repeat
 * logs again but sends nothing.
 */
export function successAfterResolutionAlert(
  operation: XeroSyncOperation | null,
): (() => Promise<void>) | null {
  if (operation?.status !== "SUCCEEDED" || !isResolvedInXero(operation)) return null;
  const context = {
    operationId: operation.id,
    localModel: operation.localModel,
    localId: operation.localId,
    xeroObjectId: operation.xeroObjectId,
  };
  const recorded = `${operation.xeroObjectType ?? "an object"} ${operation.xeroObjectNumber ?? operation.xeroObjectId ?? "(no id recorded)"}`;
  return async () => {
    logger.warn(
      context,
      "Xero success landed on an operation already resolved in Xero; Xero may now hold the item twice (INV-INT-029)",
    );
    await sendAdminAlertOnceEver({
      key: xeroSuccessAfterResolutionAlertKey(operation.id),
      label: "Xero success-after-resolution alert",
      context,
      send: async () => {
        const { sendAdminXeroSyncErrorAlert } = await import("./email");
        return sendAdminXeroSyncErrorAlert({
          errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
          operation: `${operation.operationType} ${operation.entityType} for ${operation.localModel ?? "record"} ${operation.localId ?? "unknown"} (outbox operation ${operation.id})`,
          errorMessage: `This Xero operation was marked "${resolutionLabel(operation.manuallyResolvedReason)}", and then another attempt at the same Xero call succeeded: it recorded ${recorded} in Xero. If the item was also made by hand in Xero, Xero now holds it twice. Check Xero and void the duplicate. The operation now shows as succeeded; it was marked resolved when this alert was sent.`,
          timestamp: new Date(),
        });
      },
    });
  };
}
