/**
 * #3954 review round 6 (F6), round 7 (F1): what Xero billed of the ask a
 * reduction retired is read from evidence - each row's own money by the asking
 * edit's own invoice answer (its recovery's, for a row a recovery minted; the
 * one its door stamped on the row otherwise), money a row carried in by the
 * re-issue or fold that names it - never from which supplementary invoices
 * happen to be parked yet, nor from when a row was written. Anything it cannot
 * establish is not credit-noted.
 */
import { describe, expect, it } from "vitest";

import type { UnpaidPriceAskRow } from "@/lib/additional-ask-reduction";
import { REISSUED_ASK_REASON } from "@/lib/payment-recovery-keys";
import { classifyUnpaidAskBilling, type IntentMinter } from "@/lib/unpaid-ask-billing-evidence";

const ASKED_AT = new Date("2026-06-20T00:00:00.000Z");
const AFTER = new Date("2026-06-25T00:00:00.000Z");
const NO_MINTERS = new Map<string, IntentMinter>();

function row(overrides: Partial<UnpaidPriceAskRow> = {}): UnpaidPriceAskRow {
  return {
    id: "txn_ask",
    amountCents: 5_000,
    carriedAskCents: 0,
    stripePaymentIntentId: "pi_ask",
    reason: "guest_add_price_increase",
    createdAt: ASKED_AT,
    hadIssuedXeroInvoice: true,
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
  it("MUTATION: an increase whose door stamped 'invoice issued' is a supplementary invoice's to bill, parked or not yet", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [row()], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: NO_MINTERS }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: an increase whose door stamped 'no invoice yet' was billed by the primary invoice raised afterwards", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ hadIssuedXeroInvoice: false })],
        retired: NOTHING_RETIRED,
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 0, established: true });
  });

  it("MUTATION: a row a recovery minted reads that recovery's frozen answer, not the row's own or when it was written", () => {
    // The under-credit shape: the edit saw no invoice, its mint failed, the
    // primary invoice was raised (billing the edit), then the recovery minted.
    const minted = row({ hadIssuedXeroInvoice: null, createdAt: AFTER });
    const minters = (answer: boolean | null) =>
      new Map<string, IntentMinter>([["pi_ask", { modificationId: "mod_increase", hadIssuedXeroInvoice: answer }]]);
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(false) }),
    ).toEqual({ supplementaryInvoicedCents: 0, established: true });
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(true) }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
    expect(
      classifyUnpaidAskBilling({ rows: [minted], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: minters(null) }).established,
    ).toBe(false);
  });

  it("a parked invoice covers its row: counted once, by the retire", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row()],
        retired: { invoicedCents: 5_000, parkedOps: [{ intentId: "pi_ask", anchorId: "mod_increase" }], invoiceEvidenceUnknown: false },
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 5_000, established: true });
  });

  it("MUTATION: a door-minted row with no answer recorded (minted before round 7) is not established", () => {
    expect(
      classifyUnpaidAskBilling({
        rows: [row({ hadIssuedXeroInvoice: null })],
        retired: NOTHING_RETIRED,
        modifications: [increase],
        intentMinters: NO_MINTERS,
      }).established,
    ).toBe(false);
  });

  it("MUTATION: a re-issue row's money is billed by its reduction's recorded invoice, found through the recovery that minted it; the rest by the primary", () => {
    const reissue = row({ reason: REISSUED_ASK_REASON, amountCents: 3_000, carriedAskCents: 3_000, stripePaymentIntentId: "pi_reissue" });
    expect(
      classifyUnpaidAskBilling({
        rows: [reissue],
        retired: NOTHING_RETIRED,
        modifications: [reduction(1_000)],
        intentMinters: new Map([["pi_reissue", { modificationId: "mod_reduction", hadIssuedXeroInvoice: true }]]),
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000, established: true });
    // Nothing names it: not guessed.
    expect(
      classifyUnpaidAskBilling({ rows: [reissue], retired: NOTHING_RETIRED, modifications: [reduction(1_000)], intentMinters: NO_MINTERS }).established,
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
        modifications: [folding, reduction(1_000)],
        intentMinters: NO_MINTERS,
      }),
    ).toEqual({ supplementaryInvoicedCents: 1_000 + 1_000, established: true });
  });

  it("a carried figure that does not add up (a row written before carried asks were recorded) is not established", () => {
    const first = row({ id: "txn_1", amountCents: 5_000 });
    const legacy = row({ id: "txn_2", amountCents: 8_000, carriedAskCents: 0, stripePaymentIntentId: "pi_2", createdAt: AFTER });
    expect(
      classifyUnpaidAskBilling({ rows: [first, legacy], retired: NOTHING_RETIRED, modifications: [increase], intentMinters: NO_MINTERS }).established,
    ).toBe(false);
  });

  it("a waiting increase whose invoice answer was never recorded is not established", () => {
    expect(
      classifyUnpaidAskBilling({ rows: [], retired: { ...NOTHING_RETIRED, invoiceEvidenceUnknown: true }, modifications: [], intentMinters: NO_MINTERS }).established,
    ).toBe(false);
  });
});
