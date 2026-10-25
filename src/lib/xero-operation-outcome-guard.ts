/**
 * The write guard of a Xero operation outcome (#4356, `INV-INT-028`), used by
 * `completeXeroSyncOperation` and `failXeroSyncOperation` (`xero-sync.ts`).
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";

/**
 * #4356 (`INV-INT-028`): the write guard of an outcome (`status`) on an
 * operation row. Two callers can hold one row - a start that loses the insert
 * race is handed the winner's ACTIVE row (#1354) - and each records its own
 * outcome of the same keyed Xero call there. So an outcome never replaces a
 * better one already recorded: only SUCCEEDED lands on SUCCEEDED, only
 * SUCCEEDED or PARTIAL on PARTIAL; a SUCCEEDED write lands on anything (unless
 * `alsoKeep` keeps it out). `onlyIfRunningSince` writes onto that RUNNING claim
 * only, which no recorded outcome is. Null: an unguarded write.
 */
export function outcomeWriteGuard(
  operationId: string,
  status: string,
  options: { onlyIfRunningSince?: Date; alsoKeep?: string },
): Prisma.XeroSyncOperationWhereInput | null {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!operationId) throw new Error("A Xero operation outcome needs the operation's id.");
  if (options.onlyIfRunningSince) return { status: "RUNNING", startedAt: options.onlyIfRunningSince };
  const kept = new Set(status === "SUCCEEDED" ? [] : status === "PARTIAL" ? ["SUCCEEDED"] : ["SUCCEEDED", "PARTIAL"]);
  if (options.alsoKeep) kept.add(options.alsoKeep);
  const statuses = [...kept];
  if (statuses.length === 0) return null;
  return statuses.length === 1 ? { status: { not: statuses[0] } } : { status: { notIn: statuses } };
}

/** A guarded outcome write that matched no row: nothing written, nothing alerted; answers null. */
export function refusedOutcomeWrite(operationId: string, status: string, onlyIfRunningSince?: Date): null {
  if (!onlyIfRunningSince) {
    logger.info(
      { operationId, status },
      "Xero operation outcome not recorded: the row already holds an outcome this one may not replace (INV-INT-028)",
    );
  }
  return null;
}
