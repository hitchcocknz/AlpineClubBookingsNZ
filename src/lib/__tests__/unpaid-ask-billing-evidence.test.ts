/**
 * #3954 review round 6 (F6): what Xero billed of the ask a reduction retired
 * is read from evidence - each row's own money by when it was asked against
 * when the primary invoice was linked, money a row carried in by the re-issue
 * or fold that names it - never from which supplementary invoices happen to be
 * parked yet. Anything it cannot establish is not credit-noted.
 */
import { describe, expect, it } from "vitest";

import type { UnpaidPriceAskRow } from "@/lib/additional-ask-reduction";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import { classifyUnpaidAskBilling } from "@/lib/unpaid-ask-billing-evidence";

const ASKED_AT = new Date("2026-06-20T00:00:00.000Z");
const BEFORE = new Date("2026-06-10T00:00:00.000Z");
const AFTER = new Date("2026-06-25T00:00:00.000Z");

function row(overrides: Partial<UnpaidPriceAskRow> = {}): UnpaidPriceAskRow {
  return {
    id: "txn_ask",
    amountCents: 5_000,
    carriedAskCents: 0,
    stripePaymentIntentId: "pi_ask",
    reason: "guest_add_price_increase",
    createdAt: ASKED_AT,
    ...overrides,
  };
}

const NOTHING_RETIRED = { invoicedCents: 0, parkedOps: [], invoiceEvidenceUnknown: false };
const increase = { id: "mod_increase", priceDiffCents: 5_000, changeFeeCents: 0, newData: {}, createdAt: new Date("2026-06-19T00:00:00.000Z") };
const reduction = (invoiceCents: number) => ({
  id: "mod_reduction",
  priceDiffCents: -2_000,
  changeFeeCents: 0,
  newData: invoiceCents > 0 ? { reissuedAskInvoiceCents: invoiceCents } : {},
  createdAt: new Date("2026-06-15T00:00:00.000Z"),
});

describe("classifyUnpaidAskBilling", () => {
  it("MUTATION: an increase asked AFTER the primary invoice was linked is a supplementary invoice's to bill, parked or not yet", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [row()], retired: NOTHING_RETIRED, primaryInvoiceLinkedAt: BEFORE, modifications: [increase], intentModificationIds: new Map() }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: an increase asked BEFORE the primary invoice was linked was billed by that invoice", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [row()], retired: NOTHING_RETIRED, primaryInvoiceLinkedAt: AFTER, modifications: [increase], intentModificationIds: new Map() }),
    ).toEqual({ supplementaryInvoicedCents: 0, established: true });
  });

  it("a parked invoice covers its row: counted once, by the retire", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row()],
        retired: { invoicedCents: 5_000, parkedOps: [{ intentId: "pi_ask", anchorId: "mod_increase" }], invoiceEvidenceUnknown: false },
        primaryInvoiceLinkedAt: BEFORE,
        modifications: [increase],
        intentModificationIds: new Map(),
      }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: with no primary invoice link to date a row against, nothing is established", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [row()], retired: NOTHING_RETIRED, primaryInvoiceLinkedAt: null, modifications: [increase], intentModificationIds: new Map() }).established,
    ).toBe(false);
  });

  it("MUTATION: a re-issue row's money is billed by its reduction's recorded invoice, found through the recovery that minted it; the rest by the primary", () => {
    const reissue = row({ reason: REISSUED_ASK_REASON, amountCents: 3_000, carriedAskCents: 3_000, stripePaymentIntentId: "pi_reissue" });
    expect(
      classifyUnpaidAskBilling({
        rows: [reissue],
        retired: NOTHING_RETIRED,
        primaryInvoiceLinkedAt: AFTER,
        modifications: [reduction(1_000)],
        intentModificationIds: new Map([["pi_reissue", "mod_reduction"]]),
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000, established: true });
    // Nothing names it: not guessed.
    expect(
      classifyUnpaidAskBilling({ rows: [reissue], retired: NOTHING_RETIRED, primaryInvoiceLinkedAt: AFTER, modifications: [reduction(1_000)], intentModificationIds: new Map() }).established,
    ).toBe(false);
  });

  it("MUTATION: an increase that folded a re-issue in carries its invoice, found through the fold its history records", () => {
    const folding = {
      ...increase,
      priceDiffCents: 1_000,
      newData: { foldedReissuedAskCents: 3_000, foldedReissuedAskModificationIds: ["mod_reduction"] },
    };
    const folded = row({ amountCents: 4_000, carriedAskCents: 3_000 });
    expect(
      classifyUnpaidAskBilling({
        rows: [folded],
        retired: NOTHING_RETIRED,
        primaryInvoiceLinkedAt: BEFORE,
        modifications: [folding, reduction(1_000)],
        intentModificationIds: new Map(),
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000 + 1_000, established: true });
  });

  it("a carried figure that does not add up (a row written before carried asks were recorded) is not established", () => {
    const first = row({ id: "txn_1", amountCents: 5_000 });
    const legacy = row({ id: "txn_2", amountCents: 8_000, carriedAskCents: 0, stripePaymentIntentId: "pi_2", createdAt: AFTER });
    expect(
      classifyUnpaidAskBilling({ rows: [first, legacy], retired: NOTHING_RETIRED, primaryInvoiceLinkedAt: BEFORE, modifications: [increase], intentModificationIds: new Map() }).established,
    ).toBe(false);
  });

  it("a waiting increase whose invoice answer was never recorded is not established", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [], retired: { ...NOTHING_RETIRED, invoiceEvidenceUnknown: true }, primaryInvoiceLinkedAt: BEFORE, modifications: [], intentModificationIds: new Map() }).established,
    ).toBe(false);
  });
});
