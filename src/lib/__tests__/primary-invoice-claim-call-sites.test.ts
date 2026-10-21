import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3980 (`INV-PAY-119`, `INV-LOCK-003`'s spirit for a row-lock site): the
 * inventory of the edit's claim on the Payment row. Every ordinary edit door
 * that read no primary invoice link claims it and marks its history row, and
 * the only `xeroInvoiceId: null` guard on a payment write is the claim's.
 *
 * The population is every non-test source file under `src/`, by WALK, so a
 * new writer that guards on the link the same way is seen the day it exists
 * and has to be read against this protocol (`CONCURRENCY_AND_LOCKING.md`,
 * "An edit against the primary invoice's link"). WHAT THIS CANNOT SEE: a door
 * that settles through a renamed helper; the realdb proof
 * (`primary-invoice-edit-race.realdb.test.ts`) is what holds the behaviour.
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLAIM = "src/lib/booking-primary-invoice-claim.ts";
const SETTLEMENT = "src/lib/booking-modify-settlement.ts";
const GUESTS_ROUTE = "src/app/api/bookings/[id]/guests/route.ts";
/** The doors that settle through `applyPaymentAdjustments` and write their own history row. */
const SETTLEMENT_DOORS = [
  "src/lib/booking-batch-modification-service.ts",
  "src/lib/booking-date-modification-service.ts",
  "src/lib/booking-guest-acceptance-reprice.ts",
  "src/lib/booking-guest-removal-service.ts",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return found.sort();
}

const read = (relative: string): string =>
  stripComments(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));

describe("the edit's claim on the unlinked primary invoice: call sites (#3980)", () => {
  it("the population is real, so the census is not vacuous", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    for (const file of [CLAIM, SETTLEMENT, GUESTS_ROUTE, ...SETTLEMENT_DOORS]) expect(files).toContain(file);
  });

  it("the claim guards on the link still being unset; the only other such payment write sets the link", () => {
    expect(read(CLAIM)).toMatch(/payment\.updateMany\(\{\s*where: \{ id: input\.paymentId, xeroInvoiceId: null \}/);
    const guarding = sourceFiles().filter((file) => /xeroInvoiceId: null \}/.test(read(file)) && /payment\.updateMany/.test(read(file)));
    // The inbound "invoice paid" match links a payment that has none: a link
    // writer on the same row, so it orders against the claim like the create's
    // save. A new entry here is a writer to read against the protocol.
    expect(guarding).toEqual([CLAIM, "src/lib/xero-inbound/invoice-paid-effects.ts"]);
  });

  it("applyPaymentAdjustments makes it for its doors, and each door marks its history row", () => {
    expect(read(SETTLEMENT)).toContain("await writeEditOnPayment(tx, {");
    for (const door of SETTLEMENT_DOORS) {
      const source = read(door);
      expect(source, door).toContain("applyPaymentAdjustments(");
      expect(source, door).toMatch(/primaryInvoiceSettlementHistory\((payments|paymentImpact|adjusted)\)/);
    }
  });

  it("the guests route, which settles for itself, makes the same write and marks its row", () => {
    const route = read(GUESTS_ROUTE);
    expect(route).toContain("await writeEditOnPayment(tx, { payment: booking.payment, changeFeeCents: 0 })");
    expect(route).toContain("primaryInvoiceSettlementHistory({ settledAgainstPrimaryInvoice, additionalAsk })");
  });

  it("every caller of applyPaymentAdjustments is a door that marks its row", () => {
    const callers = sourceFiles().filter(
      (file) => file !== SETTLEMENT && /\bapplyPaymentAdjustments\(/.test(read(file)),
    );
    expect(callers).toEqual(SETTLEMENT_DOORS);
  });
});
