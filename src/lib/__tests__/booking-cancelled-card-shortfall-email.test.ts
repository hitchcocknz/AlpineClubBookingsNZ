import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4097 (`INV-PAY-129`): an own-card cancel whose card refund plan carried less
 * than the refund due names what went to the card and the remainder the club
 * refunds by bank transfer - in the "Booking Cancelled" email (HTML and the
 * admin-editable body's `{{refundMessage}}`), as information, from the one
 * wording home (`booking-modified-email-copy.ts`). The officers' alert names
 * the situation.
 *
 * MUTATION PROOF. Drop the remainder branch from `bookingCancelledRefundSentence`
 * and the "both parts" cases fail; drop `byHandCents` from
 * `bookingCancelledRefundMade` and the info-box cases fail; drop the
 * remainder from the sender's or the template's call and their own case fails.
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));
const sendToAdmins = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail, sendToAdmins }));

import {
  bookingCancelledRefundMade,
  bookingCancelledRefundSentence,
  ownCardRefundWithByHandRemainderSentence,
} from "@/lib/booking-modified-email-copy";
import {
  CARD_REFUND_SHORTFALL_ALERT_BODY,
  CARD_REFUND_SHORTFALL_ALERT_LEAD,
  manualRefundTaskAlertAmountLabel,
  manualRefundTaskAlertHeading,
  manualRefundTaskAlertLabel,
  manualRefundTaskAlertNote,
} from "@/lib/email-message-notes";
import { adminManualRefundTaskTemplate } from "@/lib/email-templates/admin-finance";
import { bookingCancelledTemplate } from "@/lib/email-templates/booking";
import { alertBox } from "@/lib/email-templates/layout";
import { sendBookingCancelledEmail } from "@/lib/email/booking";
import { formatCents } from "@/lib/utils";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const fmt = (cents: number) => formatCents(cents, CLUB_FORMAT_TEST);

const BOTH_MADE =
  "A refund of $30.00 has been processed to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer.";
const BOTH_PENDING =
  "A refund of $30.00 is on its way to your original payment method, and the club will refund the remaining $15.00 to you by bank transfer.";
const BY_HAND_ONLY = "The club will refund $45.00 to you by bank transfer.";
// Pinned before #4097, unchanged with no remainder.
const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
const OWN_CARD_PENDING = "A refund of $45.00 is on its way to your original payment method.";

async function sent(method: "card" | "card_pending", byHandCents: number) {
  sendEmail.mockClear();
  await sendBookingCancelledEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    4500,
    CLUB_FORMAT_TEST,
    method,
    0,
    null,
    "cancellation-policy",
    4500,
    byHandCents,
  );
  const [call] = sendEmail.mock.calls as unknown as [[{ html: string; templateData: { refundMessage: string; refundAmount: string } }]];
  return { html: call[0].html, refundMessage: call[0].templateData.refundMessage, refundAmount: call[0].templateData.refundAmount };
}

beforeEach(() => {
  sendEmail.mockClear();
  sendToAdmins.mockClear();
});

describe("#4097: the Booking Cancelled refund line names the card's part and the bank-transfer remainder", () => {
  it.each([
    ["card", 1500, BOTH_MADE],
    ["card_pending", 1500, BOTH_PENDING],
    ["card", 4500, BY_HAND_ONLY],
    ["card_pending", 4500, BY_HAND_ONLY],
  ] as const)("%s with %i by hand: both parts, in an info box, in the HTML and {{refundMessage}}", async (method, byHandCents, sentence) => {
    const template = bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, 4500, CLUB_FORMAT_TEST, method, 0, "cancellation-policy", 4500, byHandCents);
    const sender = await sent(method, byHandCents);

    expect(template).toContain(alertBox(sentence, "info"));
    expect(sender.html).toContain(alertBox(sentence, "info"));
    expect(sender.refundMessage).toBe(sentence);
    // `{{refundAmount}}` stays the refund due in all.
    expect(sender.refundAmount).toBe("$45.00");
    for (const body of [template, sender.html, sender.refundMessage]) {
      expect(body).not.toContain("A refund of $45.00");
    }
  });

  it("keeps the wording byte-identical with no remainder", async () => {
    expect((await sent("card", 0)).refundMessage).toBe(OWN_CARD);
    expect((await sent("card_pending", 0)).refundMessage).toBe(OWN_CARD_PENDING);
    expect(bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, 4500, CLUB_FORMAT_TEST, "card")).toContain(alertBox(OWN_CARD, "success"));
  });

  it("is the one wording home's sentence, for the member or an officer", () => {
    expect(bookingCancelledRefundSentence(4500, "$45.00", "card", { cents: 1500, formatAmount: fmt })).toBe(BOTH_MADE);
    expect(ownCardRefundWithByHandRemainderSentence(3000, 1500, fmt, false)).toBe(BOTH_MADE);
    expect(ownCardRefundWithByHandRemainderSentence(3000, 1500, fmt, true, "the member's")).toBe(
      "A refund of $30.00 is on its way to the member's original payment method, and the club will refund the remaining $15.00 to the member by bank transfer.",
    );
    expect(ownCardRefundWithByHandRemainderSentence(0, 4500, fmt, false, "the member's")).toBe(
      "The club will refund $45.00 to the member by bank transfer.",
    );
  });

  it("only an own-card refund takes a remainder, and none reads as made", () => {
    expect(bookingCancelledRefundSentence(4500, "$45.00", "credit", { cents: 1500, formatAmount: fmt })).toBe(
      "A credit of $45.00 has been added to your account for future bookings.",
    );
    expect(bookingCancelledRefundMade(4500, "card", 1500)).toBe(false);
    expect(bookingCancelledRefundMade(4500, "card", 0)).toBe(true);
    expect(bookingCancelledRefundMade(4500, "card")).toBe(true);
  });
});

describe("#4097: the officers' alert names a card refund shortfall", () => {
  it("has its own subject, heading, amount label and note", () => {
    expect(manualRefundTaskAlertLabel("card-refund-shortfall")).toBe("card refund short on a cancelled booking");
    expect(manualRefundTaskAlertHeading("card-refund-shortfall")).toBe("Manual Refund Needed - Card Refund Short on a Cancelled Booking");
    expect(manualRefundTaskAlertAmountLabel("card-refund-shortfall")).toBe("Amount the card refund could not carry");
    expect(manualRefundTaskAlertNote("card-refund-shortfall")).toBe(`${CARD_REFUND_SHORTFALL_ALERT_LEAD}\n\n${CARD_REFUND_SHORTFALL_ALERT_BODY}`);
  });

  it("renders the shortfall arm, never the cash one", () => {
    const html = adminManualRefundTaskTemplate(
      {
        memberName: "Sam Lee",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        refundAmountCents: 1500,
        bookingId: "booking-1",
        reason: "reason",
        reviewUrl: "https://example.org/admin/payments",
        situation: "card-refund-shortfall",
      },
      CLUB_FORMAT_TEST,
    );

    expect(html).toContain(alertBox(CARD_REFUND_SHORTFALL_ALERT_LEAD, "warning"));
    expect(html).toContain("Amount the card refund could not carry");
    expect(html).toContain("$15.00");
    expect(html).not.toContain("settled in cash");
  });
});
