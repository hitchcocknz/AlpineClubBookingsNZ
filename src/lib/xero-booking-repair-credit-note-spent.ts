import type { BookingClassificationContext, MutableFinding } from "./xero-booking-repair-types";
import { addFinding } from "./xero-booking-repair-findings";

/**
 * #4220: the early warning that a credit note drawn onto this booking was spent
 * in Xero on something the app has no record of, before the booking's allocation
 * is attempted and refused (#4218). Report-only: no action, nothing auto-applied,
 * and no Xero call - the evidence was kept at ingest and the verdict is derived
 * now (`findCreditNotesSpentOutsideApp`). The money is brought into line by the
 * converge (#4219) when Xero refuses the allocation, or by an officer.
 */
export function addCreditNoteSpentOutsideFindings(
  findings: MutableFinding[],
  context: BookingClassificationContext,
): void {
  for (const note of context.creditNotesSpentOutsideApp ?? []) {
    addFinding(findings, {
      code: "APPLIED_CREDIT_NOTE_CONSUMED_EXTERNALLY",
      severity: "warning",
      summary:
        "A credit note drawn onto this booking was used in Xero outside the app, so Xero will refuse its allocation. Check the note in Xero before the booking's credit is allocated.",
      safeToAutoApply: false,
      details: {
        creditNoteId: note.creditNoteId,
        memberCreditId: note.lotId,
        outsideSpendCents: note.outsideSpendCents,
        leftForAllocationCents: note.leftForAllocationCents,
        observedAt: note.observedAt.toISOString(),
      },
      actionKeys: [],
    });
  }
}
