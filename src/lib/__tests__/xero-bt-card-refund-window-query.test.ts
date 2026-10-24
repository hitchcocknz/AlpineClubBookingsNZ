import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { cardRefundNoteKeyTag, cardRefundNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { CARD_REFUND_NOTE_CUTOVER_MIGRATION } from "@/lib/card-refund-own-note-share";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { parsePaymentCreditNoteRetryInput } from "@/lib/xero-payment-credit-note-payload";

/**
 * #4312 review (`INV-ADDPAY-044`, `INV-SSOT`): the UPGRADING switch-window
 * query, which lists the card refund notes this release raised for a
 * late-captured payment's refund made while the previous version still served,
 * spells by hand what the code defines once - the marker migration, a card
 * refund note row's fields and its key - because an operator runs it in psql.
 * This pins each literal to the code; `xero-bt-card-refund-notes` runs the
 * query against real PostgreSQL.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

function cardRefundWindowQuerySql(): string {
  const doc = readFileSync(resolve(REPO_ROOT, "docs/UPGRADING.md"), "utf8");
  const start = doc.indexOf("**Card refunds made in the switch window (#4312).**");
  expect(start).toBeGreaterThanOrEqual(0);
  const sql = /```sql\n([\s\S]*?)\n```/.exec(doc.slice(start))?.[1];
  expect(sql).toBeDefined();
  return sql!;
}

/** The timestamp an operator replaces with the moment this version served alone. */
const CARD_REFUND_WINDOW_QUERY_PLACEHOLDER = "TIMESTAMPTZ '2026-01-01 00:00:00+00'";

describe("the #4312 switch-window query matches the code's one definition", () => {
  const sql = cardRefundWindowQuerySql();

  it("dates the window from the marker migration the code reads", () => {
    expect([...sql.matchAll(/m\."migration_name" = '([^']*)'/g)].map((match) => match[1])).toEqual([CARD_REFUND_NOTE_CUTOVER_MIGRATION]);
    expect(sql).toContain('m."rolled_back_at" IS NULL');
    expect(sql.split(CARD_REFUND_WINDOW_QUERY_PLACEHOLDER)).toHaveLength(2);
  });

  it("dates a refund as the app does (`madeSinceCardRefundNoteCutover`): Stripe's time else the record's, in UTC, in whole seconds", () => {
    // `PaymentRefund`'s times are UTC with no zone; the marker's finish and the operator's moment carry one, so
    // each is read in UTC - never compared through the session's zone - and the marker's own second counts.
    const madeAt = "date_trunc('second', COALESCE(r.\"stripeCreatedAt\", r.\"createdAt\"))";
    expect(sql).toContain(`${madeAt} >= (SELECT date_trunc('second', min(m."finished_at") AT TIME ZONE 'UTC')`);
    expect(sql).toContain(`${madeAt} <= (${CARD_REFUND_WINDOW_QUERY_PLACEHOLDER} AT TIME ZONE 'UTC')`);
    expect(sql).not.toMatch(/\bTIMESTAMP '/);
  });

  it("finds a card refund's note rows as the code does: its payload field, or its key", () => {
    const where = cardRefundNoteRowsWhere("PAYMENT", "re_X");
    expect(sql).toContain(`o."localModel" = '${where.localModel}' AND o."entityType" = '${where.entityType}' AND o."operationType" = '${where.operationType}'`);
    const payloadKey = (where.OR[0] as { requestPayload: { path: string[] } }).requestPayload.path[0];
    expect(sql).toContain(`o."requestPayload"->>'${payloadKey}'`);
    const tag = cardRefundNoteKeyTag("re_X").split("re_X");
    expect(sql).toContain(`LIKE '%${tag[0]}' || r."stripeRefundId" || '${tag[1]}%'`);
  });

  it("keeps to late-captured payments' refunds, by the field a note row names the capture under", () => {
    const named = /o\."requestPayload"->>'(\w+)' IS NOT NULL/.exec(sql)?.[1];
    expect(named).toBeDefined();
    expect(parsePaymentCreditNoteRetryInput({ requestPayload: { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE, refundAmountCents: 100, [named!]: "pi_X" } })?.paymentIntentId).toBe("pi_X");
  });
});
