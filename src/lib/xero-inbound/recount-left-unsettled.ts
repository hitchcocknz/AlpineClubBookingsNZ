/**
 * #4095: a reconcile that wrote everything it could but left a refunded-total
 * recount unwritten (a claim lost twice, or a kept settle's recount that
 * failed) says so in its result. Every caller that retries on failure - a
 * stored inbound event, retried after its backoff, and the incremental invoice
 * reconciliation, which reports the invoice failed - fails on it here, after
 * those writes, so the retry recounts. Its own module so both callers share it
 * without an import cycle between `event-processing.ts` and `invoice.ts`.
 */
export function failIfRecountLeftUnsettled<T extends { recountLeftUnsettled?: string }>(result: T): T {
  if (result.recountLeftUnsettled) throw new Error(result.recountLeftUnsettled);
  return result;
}
