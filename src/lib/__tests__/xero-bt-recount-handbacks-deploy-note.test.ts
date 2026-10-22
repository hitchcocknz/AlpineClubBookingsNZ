import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PaymentSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX } from "@/lib/bank-refund-void-follow-up-key";
import {
  COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE,
  EDIT_REFUND_HAND_BACK_KEY_PREFIX,
  NON_CANCELLATION_HAND_BACK_WHERE,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
} from "@/lib/manual-refund-task-settlement-rules";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { BANK_TRANSFER_REFUND_SHORTFALL_ADVICE } from "@/lib/xero-inbound/credit-note-bank-transfer-floor";
import { CANCELLED_CREDIT_NOTE_STATUSES, readRefundCreditNoteLinkStatus, REFUND_CREDIT_NOTE_LINK_WHERE } from "@/lib/xero-refund-note-status";
import { recoverRefundCreditNoteLinkAmountCents } from "@/lib/xero-sync";

/**
 * #4230 (`INV-SSOT`, `INV-ADDPAY-021`): the deploy note's read-only SQL, which
 * lists bank-transfer payments whose completed hand-backs and card refunds
 * exceed their live refund notes, spells by hand what the code defines once -
 * the hand-back kind and status, the hand-backs another note answers, a
 * refused refund's statuses, a refund note's link and a cancelled note's
 * statuses - because an operator runs it in psql. This pins each literal to
 * the code, so a drift fails here rather than leaving a query that quietly
 * lists nothing. The real-PostgreSQL proof (`xero-bt-recount-handbacks`) runs
 * the same query. And the alert's advice is quoted word for word by the Xero
 * guide's troubleshooting row.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), "utf8");

function deployNoteSql(): string {
  const doc = read("docs/xero/ARCHITECTURE.md");
  const start = doc.indexOf("**Deploy note (#4230).**");
  expect(start).toBeGreaterThanOrEqual(0);
  const sql = /`(SELECT [^`]*)`/.exec(doc.slice(start))?.[1];
  expect(sql).toBeDefined();
  return sql!;
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!);
const list = (text: string) => text.split(", ").map((item) => item.slice(1, -1));

describe("the #4230 deploy note's SQL matches the code's one definition", () => {
  const sql = deployNoteSql();

  it("counts completed hand-backs, leaving out exactly those another note answers", () => {
    expect(all(sql, /m\.kind = '([^']*)'/g)).toEqual([NON_CANCELLATION_HAND_BACK_WHERE.kind]);
    expect(all(sql, /m\.status = '([^']*)'/g)).toEqual([COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE.status]);
    const excluded = all(sql, /NOT starts_with\(coalesce\(m\."occurrenceKey", ''\), '([^']*)'\)/g);
    expect(new Set(excluded)).toEqual(new Set([EDIT_REFUND_HAND_BACK_KEY_PREFIX, REFUND_REQUEST_HAND_BACK_KEY_PREFIX, BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX]));
    expect(excluded).toHaveLength(3);
  });

  it("counts card refunds as the ledger does, never a refused one", () => {
    const statuses = all(sql, /f\.status NOT IN \(([^)]*)\)/g);
    expect(statuses).toHaveLength(1);
    expect(new Set(list(statuses[0]!))).toEqual(new Set(EXCLUDED_LEDGER_REFUND_STATUSES));
  });

  it("reads live refund notes' amounts by the link filter, field and statuses the code reads", async () => {
    const [link] = [...sql.matchAll(/l\."localModel" = '([^']*)' AND l\."localId" = p\.id AND l\."xeroObjectType" = '([^']*)' AND l\.role = '([^']*)' AND l\.active/g)];
    expect(link).toBeDefined();
    expect({ localModel: link![1], xeroObjectType: link![2], role: link![3] }).toEqual(REFUND_CREDIT_NOTE_LINK_WHERE);
    const cancelled = all(sql, /upper\(trim\(coalesce\(l\.metadata->>'status', ''\)\)\) NOT IN \(([^)]*)\)/g);
    expect(cancelled).toHaveLength(1);
    expect(new Set(list(cancelled[0]!))).toEqual(new Set(CANCELLED_CREDIT_NOTE_STATUSES));
    expect(readRefundCreditNoteLinkStatus({ status: " voided " })).toBe("VOIDED");
    for (const field of new Set(all(sql, /l\.metadata->>?'([^']*)'/g).filter((key) => key !== "status"))) {
      const noRow = { xeroSyncOperation: { findFirst: async () => null } } as never;
      expect(await recoverRefundCreditNoteLinkAmountCents("PAYMENT", { xeroObjectId: "NOTE", metadata: { [field]: 1234 } }, noRow)).toBe(1234);
    }
  });

  it("lists bank-transfer payments only", () => {
    expect(all(sql, /p\.source = '([^']*)'/g)).toEqual([PaymentSource.INTERNET_BANKING]);
  });
});

describe("the bank-transfer floor's alert advice is the one the Xero guide quotes (#4230)", () => {
  it("is quoted word for word, in plain English with no issue numbers", () => {
    expect(read("docs/guides/xero.md")).toContain(`"${BANK_TRANSFER_REFUND_SHORTFALL_ADVICE}"`);
    expect(BANK_TRANSFER_REFUND_SHORTFALL_ADVICE).not.toMatch(/#\d|`/);
  });
});
