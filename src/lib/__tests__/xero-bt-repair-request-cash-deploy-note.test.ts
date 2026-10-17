import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
} from "@/lib/manual-refund-task-settlement-rules";
import { refundRequestCreditNoteKey } from "@/lib/xero-credit-notes";

/**
 * #4231 (`INV-SSOT`, lens F3): the #4215 deploy note's read-only SQL spells a
 * refund request's paid-back hand-back - kind, status, key prefix - and a
 * request note's key by hand, because an operator runs it in psql. This pins
 * every such literal in that note to the code's one definition, so a drift in
 * either fails here rather than leaving an operator with a query that quietly
 * lists nothing.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

function deployNote(): string {
  const doc = readFileSync(resolve(REPO_ROOT, "docs/xero/ARCHITECTURE.md"), "utf8");
  const start = doc.indexOf("**Deploy and rollback note (#4215).**");
  const end = doc.indexOf("**Re-raising a voided request note is the officer's decision (#4214", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);

describe("the #4215 deploy note's SQL matches the code's one definition (#4231)", () => {
  const note = deployNote();
  const where = COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE;

  it("spells the hand-back's kind, status and key prefix as the where fragment does", () => {
    const kinds = all(note, /m\.kind = '([^']*)'/g);
    const statuses = all(note, /m\.status = '([^']*)'/g);
    const prefixes = all(note, /starts_with\(m\."occurrenceKey", '([^']*)'\)/g);
    // Both checks name the hand-back twice: in the request-cash column and in the filter.
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(kinds)).toEqual(new Set([where.kind]));
    expect(statuses.length).toBe(kinds.length);
    expect(new Set(statuses)).toEqual(new Set([where.status]));
    expect(prefixes.length).toBe(kinds.length);
    expect(new Set(prefixes)).toEqual(new Set([where.occurrenceKey.startsWith, REFUND_REQUEST_HAND_BACK_KEY_PREFIX]));
  });

  it("cuts the request id off the occurrence key at the prefix's length", () => {
    const offsets = all(note, /substr\(m\."occurrenceKey", (\d+)\)/g);
    expect(offsets.length).toBeGreaterThan(0);
    // SQL's substr is 1-based: the id starts one past the prefix.
    expect(new Set(offsets)).toEqual(new Set([String(REFUND_REQUEST_HAND_BACK_KEY_PREFIX.length + 1)]));
  });

  it("builds a request note's key prefix as `refundRequestCreditNoteKey` does", () => {
    const built = note.match(/'([^']*)' \|\| p\.id \|\| '([^']*)' \|\| substr\(m\."occurrenceKey", \d+\) \|\| '([^']*)'/);
    expect(built).not.toBeNull();
    const [, head, middle, tail] = built!;
    expect(refundRequestCreditNoteKey("PAYMENT", "REQUEST").startsWith(`${head}PAYMENT${middle}REQUEST${tail}`)).toBe(true);
  });
});
