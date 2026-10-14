import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/additional-payment-card", () => ({ AdditionalPaymentCard: ({ additionalAmountCents }: { additionalAmountCents: number }) => <p>Card ask {additionalAmountCents}</p> }));
import { BookingOutstandingPayments } from "../_components/booking-outstanding-payments";
import type { BookingOutstandingPaymentView } from "@/lib/booking-outstanding-payment";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { requireClubTimeZone } from "@/lib/club-time";
const base: Extract<BookingOutstandingPaymentView, { kind: "ready" }> = {
  kind: "ready", audience: "owner", bookingStatus: "COMPLETED", revision: "revision", cardDueCents: 0, cardRevision: "card", incomplete: false, nextCursor: null,
  observations: [{ kind: "payable", invoiceId: "supplement", invoiceNumber: "INV-EXTRA", reference: "Supplementary booking", dueCents: 1234, observedAt: "2026-07-01T00:00:00Z" }],
};
const render = (initial: BookingOutstandingPaymentView) => renderToStaticMarkup(<BookingOutstandingPayments bookingId="booking" initial={initial} format={CLUB_FORMAT_TEST} zone={requireClubTimeZone("Pacific/Auckland")} />);
describe("individual outstanding amounts and audience", () => {
  it("shows remaining amount, correct supplementary invoice and bank-payment instructions", () => {
    const html = render(base);
    expect(html).toContain("$12.34"); expect(html).toContain("INV-EXTRA"); expect(html).toContain("internet banking"); expect(html).toContain("bank details on that invoice");
    expect(html).not.toContain("No payment"); expect(html).not.toContain("Card ask");
  });
  it("shows every independent demand without a combined total", () => {
    const html = render({ ...base, observations: [...base.observations, { ...base.observations[0]!, invoiceId: "second", invoiceNumber: "INV-SECOND", kind: "payable", dueCents: 5678, reference: null }] });
    expect(html).toContain("$56.78"); expect(html).toContain("INV-SECOND"); expect(html).not.toContain("$69.12");
  });
  it("links the owner to their actual card, with a read-only officer audience", () => {
    expect(render({ ...base, cardDueCents: 2500 })).toContain('href="#additional-payment"');
    expect(render({ ...base, cardDueCents: 2500 })).toContain("Card ask 2500");
    const officer = render({ ...base, audience: "officer", cardDueCents: 2500 });
    expect(officer).toContain("The member has"); expect(officer).not.toContain("Card ask"); expect(officer).not.toContain('href="#additional-payment"');
    expect(render({ kind: "hidden" })).toBe("");
  });
  it("never labels incomplete or withdrawn evidence settled", () => {
    const html = render({ ...base, observations: [], incomplete: true, nextCursor: "signed" });
    expect(html).toContain("cannot yet be confirmed"); expect(html).toContain("Check more invoices"); expect(html).not.toContain("nothing");
    expect(render({ ...base, observations: [{ kind: "retired", invoiceId: "supplement", invoiceNumber: "INV-EXTRA", status: "VOIDED", observedAt: "2026-07-01T00:00:00Z" }] })).toContain("replacement amount");
  });
});
