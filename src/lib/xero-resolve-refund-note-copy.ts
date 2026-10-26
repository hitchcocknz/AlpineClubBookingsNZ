// #4421 (`INV-INT-028`, `INV-SSOT`): what "Resolve by hand" on the Xero
// operations panel says and accepts, in one client-safe module the resolve
// route's schema, the resolve module and the panel's dialogs all read.
import { EXAMPLE_CREDIT_NOTE_NUMBER } from "@/lib/bank-refund-void-follow-up-copy";

/** The resolve reason's bounds, as the route checks them and the dialogs enforce them. */
export const RESOLVE_REASON_MIN = 3;
export const RESOLVE_REASON_MAX = 500;

/** The refusal when a refund credit note is resolved without the number of the note made in Xero. */
export const RESOLVE_NOTE_NUMBER_REQUIRED_MESSAGE = `This is a refund credit note. Type the number of the credit note you made in Xero (for example ${EXAMPLE_CREDIT_NOTE_NUMBER}), so the app can check it and record which note it is.`;

/**
 * The refusal of a refund credit note whose amount the app cannot read: no
 * note can be checked against it, and Retry refuses it too, so Mark
 * non-replayable is the way off the list (review: money F2, security F5).
 */
export const RESOLVE_NOTE_AMOUNT_UNREADABLE_MESSAGE =
  "The app cannot read this refund credit note's amount, so it cannot check a credit note made in Xero against it, and it cannot retry it either. Use Mark non-replayable on it, and ask the treasurer what this refund needs in Xero. Don't also make a credit note by hand.";

/** The refusal of a note number sent for a row that takes none (review: money F5). */
export const RESOLVE_NOTE_NOT_ASKED_MESSAGE =
  "This job already names its credit note, or doesn't take a credit note number. Reload it and check before resolving.";

/** The refusal when a retry of the job ran or is running beside the resolve (review: concurrency F1). */
export const RESOLVE_NOTE_RETRY_RAN_MESSAGE =
  "A retry of this refund credit note ran while you were resolving it, and it may have made a credit note in Xero. Nothing was recorded. Wait for the retry to finish and check Xero before resolving again.";

/** What a second officer is told when the job was resolved first by someone else (review: concurrency F6). */
export function alreadyResolvedWithNoteMessage(recordedNumber: string | null): string {
  return recordedNumber
    ? `This refund credit note was already resolved, recording credit note ${recordedNumber}. Check Xero: if that is not the note for this refund, ask the treasurer.`
    : "This refund credit note was already resolved, with no credit note number recorded. Check Xero and ask the treasurer before making any other note for it.";
}
