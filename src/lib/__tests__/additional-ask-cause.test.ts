import { describe, expect, it } from "vitest";

import {
  additionalAskCause,
  memberCardFallbackParts,
  memberCardFallbackSentence,
  officerPanelParts,
  officerPanelSentence,
  preArrivalOutstandingNote,
  timelinePaidDetail,
  timelinePendingDetail,
  type AdditionalAskCause,
} from "@/lib/additional-ask-cause";
import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";

const release = (carriedAskCents = 0, withdrawnAt: Date | null = null) => ({
  reason: CREDIT_RELEASE_ASK_REASON,
  carriedAskCents,
  withdrawnAt,
});
const edit = (carriedAskCents = 0, withdrawnAt: Date | null = null) => ({
  reason: "booking_modification",
  carriedAskCents,
  withdrawnAt,
});

describe("additionalAskCause (#4253, INV-ADDPAY-048)", () => {
  it("reads no rows as an ordinary change, the wording every surface had before", () => {
    expect(additionalAskCause([])).toBe("edit");
  });

  it("reads a lone release row as credit used elsewhere, and a lone edit row as a change", () => {
    expect(additionalAskCause([release()])).toBe("credit-release");
    expect(additionalAskCause([edit()])).toBe("edit");
    expect(additionalAskCause([{ reason: null, carriedAskCents: 0 }])).toBe("edit");
  });

  it("reads an edit that carried an unpaid release as BOTH, so the one request is worded as both", () => {
    expect(additionalAskCause([edit(4_000), release()])).toBe("mixed");
  });

  it("reads a release that carried an unpaid edit as both", () => {
    expect(additionalAskCause([release(2_000), edit()])).toBe("mixed");
  });

  it("does not look behind a row that carried nothing", () => {
    expect(additionalAskCause([edit(0), release()])).toBe("edit");
    expect(additionalAskCause([release(0), edit()])).toBe("credit-release");
  });

  it("stops at an officer-withdrawn row, which is not carried", () => {
    expect(additionalAskCause([edit(4_000), release(0, new Date("2026-07-01T00:00:00Z"))])).toBe("edit");
  });

  it("follows the chain one carried row at a time", () => {
    expect(additionalAskCause([release(3_000), release(2_000), edit()])).toBe("mixed");
    expect(additionalAskCause([release(3_000), release(0), edit()])).toBe("credit-release");
  });
});

describe("the shared sentences", () => {
  const causes: AdditionalAskCause[] = ["edit", "credit-release", "mixed"];

  it("keeps the ordinary change wording exactly as it was", () => {
    expect(timelinePendingDetail("edit")).toBe("A booking change increased the total. This extra amount has not been paid yet.");
    expect(timelinePaidDetail("edit")).toBe("A booking change increased the total and the extra payment succeeded.");
    expect(officerPanelSentence("edit", "$10.00")).toBe(
      "A change to this booking increased the total by $10.00, and that amount has not been collected.",
    );
    expect(memberCardFallbackSentence("edit", "$10.00")).toBe(
      "A recent booking modification means $10.00 is still owing on this booking according to our records.",
    );
    expect(preArrivalOutstandingNote("edit", "$10.00")).toBe(
      "There is still $10.00 to pay on this booking after a change to your stay. Please pay it from your booking page before you arrive.",
    );
  });

  it("never says a change raised the total where the request is only credit used elsewhere", () => {
    const words = [
      timelinePendingDetail("credit-release"),
      timelinePaidDetail("credit-release"),
      officerPanelSentence("credit-release", "$10.00"),
      memberCardFallbackSentence("credit-release", "$10.00"),
      preArrivalOutstandingNote("credit-release", "$10.00"),
    ];
    for (const sentence of words) {
      expect(sentence).toMatch(/used elsewhere in the club's accounts/);
      expect(sentence).not.toMatch(/booking change|modification|change to (this|your)/i);
    }
  });

  it("names both causes where the request is mixed", () => {
    const words = [
      timelinePendingDetail("mixed"),
      timelinePaidDetail("mixed"),
      officerPanelSentence("mixed", "$10.00"),
      memberCardFallbackSentence("mixed", "$10.00"),
      preArrivalOutstandingNote("mixed", "$10.00"),
    ];
    for (const sentence of words) {
      expect(sentence).toMatch(/change/);
      expect(sentence).toMatch(/used elsewhere in the club's accounts/);
    }
  });

  it("builds the plain sentence from the two pieces either side of the amount", () => {
    for (const cause of causes) {
      const officer = officerPanelParts(cause);
      const member = memberCardFallbackParts(cause);
      expect(officerPanelSentence(cause, "$1.00")).toBe(`${officer.lead}$1.00${officer.trail}`);
      expect(memberCardFallbackSentence(cause, "$1.00")).toBe(`${member.lead}$1.00${member.trail}`);
    }
  });
});
