import type { Prisma } from "@prisma/client";

import { formatCentsPlain } from "@/lib/utils";
import {
  classifyVoidedBankRefundNote,
  readVoidedBankRefundNoteLinkIds,
  type BankRefundVoidClassification,
  type BankRefundVoidUnmatchedReason,
} from "@/lib/bank-refund-void-scan";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): THE READ-ONLY COUNT
 * the owner runs before switching the nightly follow-up's writes on
 * (`pnpm run xero:bank-refund-void-count`). It sorts every voided bank-transfer
 * refund note with the SAME classifier the job uses
 * (`classifyVoidedBankRefundNote`), so what it counts is what the first
 * writing run will do, and adds one population the job never touches:
 * bank-transfer payments whose refunded total is below their own transaction
 * detail with no voided note to explain it.
 *
 * Reads only: no transaction, no lock, no write, no provider call.
 */

export type BankRefundVoidCountBucket =
  | "awaiting-heal"
  | "handled-follow-up"
  | "handled-spare"
  | "handled-answered"
  | "deferred"
  | "spare"
  | "undo-total-below-detail"
  | "undo-total-equal-detail"
  | `unmatched-${BankRefundVoidUnmatchedReason}`
  | "not-in-scope";

export interface BankRefundVoidCount {
  voidedNotes: number;
  buckets: Partial<Record<BankRefundVoidCountBucket, { count: number; amountCents: number; linkIds: string[] }>>;
  /** Bank-transfer payments whose total is below their detail, with no voided refund note. */
  totalBelowDetailWithoutVoid: { count: number; gapCents: number; paymentIds: string[] };
}

function bucketOf(c: BankRefundVoidClassification, figures: { refundedCents: number; detailCents: number } | null): BankRefundVoidCountBucket {
  switch (c.kind) {
    case "handled":
      return c.by === "follow-up" ? "handled-follow-up" : c.by === "spare" ? "handled-spare" : "handled-answered";
    case "undo":
      return figures && figures.refundedCents < figures.detailCents ? "undo-total-below-detail" : "undo-total-equal-detail";
    case "unmatched":
      return `unmatched-${c.reason}`;
    default:
      return c.kind;
  }
}

function amountOf(c: BankRefundVoidClassification): number {
  return c.kind === "undo" || c.kind === "spare" ? c.amountCents : c.kind === "unmatched" ? (c.amountCents ?? 0) : 0;
}

export async function countBankRefundVoids(db: Prisma.TransactionClient): Promise<BankRefundVoidCount> {
  const linkIds = await readVoidedBankRefundNoteLinkIds(db);
  const result: BankRefundVoidCount = {
    voidedNotes: linkIds.length,
    buckets: {},
    totalBelowDetailWithoutVoid: { count: 0, gapCents: 0, paymentIds: [] },
  };
  const voidedPaymentIds = new Set<string>();
  for (const linkId of linkIds) {
    const note = await classifyVoidedBankRefundNote(db, linkId);
    if (!note) continue;
    voidedPaymentIds.add(note.paymentId);
    const bucket = bucketOf(note.classification, note.figures);
    const entry = (result.buckets[bucket] ??= { count: 0, amountCents: 0, linkIds: [] });
    entry.count += 1;
    entry.amountCents += amountOf(note.classification);
    entry.linkIds.push(linkId);
  }

  const details = await db.paymentTransaction.groupBy({
    by: ["paymentId"],
    where: { payment: { source: "INTERNET_BANKING" }, refundedAmountCents: { gt: 0 } },
    _sum: { refundedAmountCents: true },
  });
  const detailByPayment = new Map(details.map((row) => [row.paymentId, Math.max(0, row._sum.refundedAmountCents ?? 0)]));
  const paymentIds = [...detailByPayment.keys()];
  for (let start = 0; start < paymentIds.length; start += 1_000) {
    const payments = await db.payment.findMany({
      where: { id: { in: paymentIds.slice(start, start + 1_000) } },
      select: { id: true, refundedAmountCents: true },
    });
    for (const payment of payments) {
      const detailCents = detailByPayment.get(payment.id) ?? 0;
      if (payment.refundedAmountCents >= detailCents || voidedPaymentIds.has(payment.id)) continue;
      result.totalBelowDetailWithoutVoid.count += 1;
      result.totalBelowDetailWithoutVoid.gapCents += detailCents - payment.refundedAmountCents;
      result.totalBelowDetailWithoutVoid.paymentIds.push(payment.id);
    }
  }
  return result;
}

const BUCKET_LABELS: Record<string, string> = {
  "awaiting-heal": "Still active, awaiting the #4161 heal (handled the night after it runs)",
  "handled-follow-up": "Already handled: a follow-up is on the refund list",
  "handled-spare": "Already handled: recorded as a spare",
  "handled-answered": "Already handled: answered by a person on Stuck States",
  deferred: "Deferred: a refund-note create on the payment could still mint",
  spare: "Spare: live notes still cover every bank hand-back; nothing will move",
  "undo-total-below-detail": "Will be undone (one follow-up each); the payment's total is already below its detail",
  "undo-total-equal-detail": "Will be undone (one follow-up each); the payment's total still counts the refund",
  "unmatched-amount-unknown": "Unmatched, to a person: the note's amount cannot be read",
  "unmatched-no-line": "Unmatched, to a person: no single live hand-back line for the amount",
  "unmatched-ambiguous": "Unmatched, to a person: more than one hand-back could be the one",
  "unmatched-detail-short": "Unmatched, to a person: the payment's detail no longer holds the amount",
  "not-in-scope": "Not in scope (re-checked in code)",
};

/** The plain-text report the owner reads. Counts and cents only, unless `list` asks for ids. */
export function formatBankRefundVoidCount(count: BankRefundVoidCount, options?: { list?: boolean }): string {
  const lines = [`Voided bank-transfer refund credit notes: ${count.voidedNotes}`];
  for (const [bucket, label] of Object.entries(BUCKET_LABELS)) {
    const entry = count.buckets[bucket as BankRefundVoidCountBucket];
    if (!entry) continue;
    lines.push(`  ${label}: ${entry.count} (${formatCentsPlain(entry.amountCents)})`);
    if (options?.list) lines.push(...entry.linkIds.map((id) => `    link ${id}`));
  }
  const gap = count.totalBelowDetailWithoutVoid;
  lines.push(
    `Bank-transfer payments whose refunded total is below their own detail, with no voided note: ${gap.count} (${formatCentsPlain(gap.gapCents)})`,
  );
  if (options?.list) lines.push(...gap.paymentIds.map((id) => `    payment ${id}`));
  return lines.join("\n");
}
