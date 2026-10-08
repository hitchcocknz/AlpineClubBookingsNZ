import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #3973 — the "Booking Cancelled" email names the group organiser's card.
 *
 * A joiner cancelling a booking the group organiser paid for by card is refunded
 * to the ORGANISER's card (#3653), but the email told the joiner the refund had
 * gone "to your original payment method". The cancel's organiser-card branch now
 * passes "organiser_card", and the HTML email and the admin-editable body's
 * `{{refundMessage}}` both take their line from `bookingCancelledRefundSentence`,
 * whose organiser-card case is the sentence #3916 wrote for Booking Modified
 * (`organiserCardRefundSentence`), so neither the two paths nor the two emails
 * can drift apart. The other wordings are pinned here and by the render pins.
 *
 * MUTATION PROOF. Drop the "organiser_card" case (it falls through to no
 * sentence) or map it to the own-card sentence and "organiser's card" fails;
 * reword the shared sentence and "from the one home" fails too. In
 * `booking-cancel.test.ts` (#3653), passing "card" to the email from the
 * organiser-card branch fails; the audit there must still record "card".
 */

const sendEmail = vi.hoisted(() => vi.fn(async () => ({ delivered: true })));

vi.mock("@/lib/email/core", () => ({ sendEmail }));

import {
  type BookingCancelledRefundMethod,
  bookingModifiedRefundSentence,
  organiserCardRefundSentence,
} from "@/lib/booking-modified-email-copy";
import { bookingCancelledTemplate } from "@/lib/email-templates/booking";
import { sendBookingCancelledEmail } from "@/lib/email/booking";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

const ORGANISER_CARD =
  "A refund of $45.00 has been processed to the group organiser's card, because the group organiser paid for this booking.";
const OWN_CARD = "A refund of $45.00 has been processed to your original payment method.";
const CREDIT = "A credit of $45.00 has been added to your account for future bookings.";
const MANUAL =
  "You paid for this booking in cash or by bank transfer, so there is no card payment to reverse. The club will arrange your refund of $45.00 directly and will be in touch.";
const NO_REFUND = "No refund was applicable based on the cancellation policy.";

function html(refundCents: number, method: BookingCancelledRefundMethod) {
  return bookingCancelledTemplate("Sam", CHECK_IN, CHECK_OUT, refundCents, CLUB_FORMAT_TEST, method);
}

/** What the sender handed to the mailer: its HTML and the flat body's `{{refundMessage}}`. */
async function sent(refundCents: number, method: BookingCancelledRefundMethod) {
  sendEmail.mockClear();
  await sendBookingCancelledEmail(
    { bookingId: "booking-1", recipientMemberId: "member-1" },
    "sam@example.org",
    "Sam",
    CHECK_IN,
    CHECK_OUT,
    refundCents,
    CLUB_FORMAT_TEST,
    method,
  );
  const [call] = sendEmail.mock.calls as unknown as [[{ html: string; templateData: { refundMessage: string } }]];
  return { html: call[0].html, refundMessage: call[0].templateData.refundMessage };
}

beforeEach(() => {
  sendEmail.mockClear();
});

describe("#3973: the Booking Cancelled refund line names where the refund went", () => {
  it("organiser's card: names the group organiser's card, never the joiner's payment method", async () => {
    const template = html(4500, "organiser_card");
    const sender = await sent(4500, "organiser_card");

    expect(template).toContain(ORGANISER_CARD);
    expect(template).not.toContain("your original payment method");
    expect(sender.refundMessage).toBe(ORGANISER_CARD);
    expect(sender.html).toContain(ORGANISER_CARD);
    expect(sender.html).not.toContain("your original payment method");
  });

  it("is the Booking Modified sentence, from the one home", () => {
    expect(organiserCardRefundSentence("$45.00")).toBe(ORGANISER_CARD);
    expect(bookingModifiedRefundSentence("$45.00", false, true)).toBe(ORGANISER_CARD);
  });

  it.each([
    ["card", OWN_CARD],
    ["credit", CREDIT],
    ["manual", MANUAL],
  ] as const)("%s: byte-identical to before, and no organiser's card", async (method, sentence) => {
    const template = html(4500, method);
    const sender = await sent(4500, method);

    expect(template).toContain(sentence);
    expect(template).not.toContain("organiser's card");
    expect(sender.refundMessage).toBe(sentence);
  });

  it("claims no refund when nothing was refunded, organiser-paid or not", async () => {
    expect(html(0, "organiser_card")).toContain(NO_REFUND);
    expect(html(0, "organiser_card")).not.toContain("organiser's card");
    expect((await sent(0, "organiser_card")).refundMessage).toBe(NO_REFUND);
  });
});
