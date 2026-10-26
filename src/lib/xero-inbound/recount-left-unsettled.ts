/**
 * #4095: a reconcile that wrote everything it could but left a refunded-total
 * recount unwritten (a claim lost twice, or a kept settle's recount that
 * failed) says so in its result, and its caller fails on it here, after those
 * writes. A stored inbound event is retried after its backoff, so the retry
 * recounts. The incremental invoice reconciliation is never retried - the
 * membership cursor has moved past the invoice - so it reports the invoice
 * failed and alerts a person first (`runIncrementalInvoiceReconciliation`).
 * Its own module so both callers share it without an import cycle between
 * `event-processing.ts` and `invoice.ts`.
 */
export function failIfRecountLeftUnsettled<T extends { recountLeftUnsettled?: string }>(result: T): T {
  if (result.recountLeftUnsettled) throw new Error(result.recountLeftUnsettled);
  return result;
}
