import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  loadOffer: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("@/lib/credit-release-bank-transfer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/credit-release-bank-transfer")),
  loadBankTransferOffer: mocks.loadOffer,
}));
vi.mock("@/lib/email-theme", () => ({
  emailPalette: () => ({ gold: "#e7b83f", charcoal: "#374151", deep: "#1f2937", mist: "#e5e7eb", snow: "#ffffff", ridge: "#6b7280" }),
  ensureEmailPaletteReady: async () => ({ source: "club-theme" as const }),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { sendAdditionalPaymentReminderEmail } from "@/lib/email/booking";

/*
  #4253 release 2 (`INV-ADDPAY-047`, `INV-ADDPAY-048`): the request email's cause wording and its
  bank-transfer offer. The sender owns which template, subject and tokens go out for a cause.
*/
const params = {
  bookingId: "bk_1",
  recipientMemberId: "mem_1",
  email: "tara@example.test",
  firstName: "Tara",
  additionalAmountCents: 4_500,
  checkIn: new Date("2026-08-03T00:00:00.000Z"),
  checkOut: new Date("2026-08-05T00:00:00.000Z"),
  requestedOn: new Date("2026-07-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
  mocks.loadOffer.mockResolvedValue(null);
});

const sent = () => mocks.sendEmail.mock.calls[0][0] as { subject: string; html: string; templateName: string; templateData: Record<string, string> };

describe("sendAdditionalPaymentReminderEmail for credit used elsewhere", () => {
  it("is card-only while there is no bank-transfer offer", async () => {
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "credit-release", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(mocks.loadOffer).toHaveBeenCalledWith("INV-9");
    expect(sent().templateName).toBe("credit-released-payment-request");
    expect(sent().subject).toBe("Payment needed for your lodge booking");
    expect(sent().html).not.toMatch(/bank transfer/i);
    expect(sent().templateData.bankTransferNote).toBe("");
  });

  it("adds the transfer offer, with the reference, to both the page and the editable body", async () => {
    mocks.loadOffer.mockResolvedValue({ instructions: "Account 12-3456", reference: "INV-9" });
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "credit-release", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(sent().html).toContain("pay by bank transfer");
    expect(sent().html).toContain("INV-9");
    expect(sent().html).toContain("Account 12-3456");
    expect(sent().templateData.bankTransferNote).toBe(
      "You can also pay by bank transfer. Use the payment reference INV-9.\nAccount 12-3456\n\n",
    );
  });

  it("says both causes in the one email where an edit was merged into the request", async () => {
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "mixed", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(sent().templateName).toBe("credit-released-payment-request");
    expect(sent().html).toMatch(/a change to your booking, and account credit applied to it that was used elsewhere in the club's accounts/);
  });

  it("offers no bank transfer on a merged request: its amount includes money not owed on the invoice a transfer would quote", async () => {
    mocks.loadOffer.mockResolvedValue({ instructions: "Account 12-3456", reference: "INV-9" });
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "mixed", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(mocks.loadOffer).not.toHaveBeenCalled();
    expect(sent().html).not.toMatch(/bank transfer/i);
    expect(sent().templateData.bankTransferNote).toBe("");
  });

  it("never mentions a booking change where the request is only the released credit", async () => {
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "credit-release" }, CLUB_FORMAT_TEST);
    expect(sent().html).toMatch(/used elsewhere in the club's accounts/);
    expect(sent().html).not.toMatch(/change to your booking/i);
  });

  it("escapes the club's words in the page", async () => {
    mocks.loadOffer.mockResolvedValue({ instructions: "<b>Account</b> & Co", reference: "INV-9" });
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "credit-release", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(sent().html).toContain("&lt;b&gt;Account&lt;/b&gt; &amp; Co");
    expect(sent().html).not.toContain("<b>Account</b>");
  });
});

describe("sendAdditionalPaymentReminderEmail for an ordinary change", () => {
  it("never reads the bank-transfer offer and keeps its own template", async () => {
    await sendAdditionalPaymentReminderEmail({ ...params, askCause: "edit", bankTransferInvoiceNumber: "INV-9" }, CLUB_FORMAT_TEST);
    expect(mocks.loadOffer).not.toHaveBeenCalled();
    expect(sent().templateName).toBe("additional-payment-reminder");
    expect(sent().templateData).not.toHaveProperty("bankTransferNote");
  });

  it("reads an absent cause as an ordinary change", async () => {
    await sendAdditionalPaymentReminderEmail(params, CLUB_FORMAT_TEST);
    expect(sent().templateName).toBe("additional-payment-reminder");
  });
});
