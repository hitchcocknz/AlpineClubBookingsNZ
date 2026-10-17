/**
 * #4210 (`INV-PAY-136`): what the officers are told when Stripe fails, after
 * accepting it, a card refund a "Paid another way" close had already settled.
 * One builder for the hand-built HTML
 * (`email-templates/admin-card-refund-failed-after-paid-another-way.ts`) and
 * the `{{paidAnotherWayFailedLaterNote}}` token an admin's saved body renders,
 * so the two cannot say different things about money. A leaf module: the
 * registry imports it without loading the email layout.
 */

/** How the failed-later writer decided a refund a close had settled (`card-refund-failed-later-paid-another-way.ts`). */
export type PaidAnotherWayFailedLaterOutcome = "settled-paid-another-way" | "raised-check-part-close" | "raised-check-resolved";

export type PaidAnotherWayFailedLaterNoteInput = {
  outcome: PaidAnotherWayFailedLaterOutcome;
  stripeRefundId: string;
  /** The failed refund, formatted. */
  amount: string;
  /** What the close paid back, and what it owed when it closed, formatted. */
  paidBack: string;
  owed: string;
  /** The close paid back less than it owed (a part close). */
  partClose: boolean;
  /** What is raised for an officer to check, formatted (the check outcomes). */
  check: string;
  /** The refund was counted under "Card refunds paid back twice" (`cardRefundsSentAfterPaidAnotherWay`). */
  onPaidTwiceList: boolean;
  /** The note the paid-twice row was marked Resolved with, if it was. */
  resolutionNote: string | null;
};

const GAVE_UP_ON = '"Card refunds Stripe gave up on" on the Stuck states page';

export function paidAnotherWayFailedLaterNote(note: PaidAnotherWayFailedLaterNoteInput): string {
  const close = note.partClose
    ? `paid the member back ${note.paidBack} of the ${note.owed} it owed and gave the rest up`
    : `paid the member back ${note.paidBack}`;
  const list = note.onPaidTwiceList ? ' It showed under "Card refunds paid back twice", and leaves that list now.' : "";
  const lead = `Stripe reported card refund ${note.stripeRefundId} of ${note.amount} failed after accepting it, so that money did not reach the member's card. The card refund it belongs to had already been closed as paid another way, before the app counted this refund, and that close ${close}.${list}`;
  switch (note.outcome) {
    case "settled-paid-another-way":
      return `${lead} The member has had this money back once, by the close, so it is not owed again and is not asked for again. Do not pay the member again unless they have already returned the extra; if you only asked, tell them not to send it. Raise no other refund note for it in Xero: if a card refund credit note was raised while Stripe counted it, it no longer matches money paid back, and the Xero reconciliation report lists it as refund coverage above the refunded total, for you to correct in Xero.`;
    case "raised-check-part-close":
      return `${lead} Up to ${note.check} of this refund may be part of what the close gave up, so ${note.check} is listed under ${GAVE_UP_ON} for you to check. It is not asked for again automatically. If the member is owed it, pay them another way and close it there; if they are not, ask a developer to reconcile it. The rest was paid back by the close: do not pay it again.`;
    case "raised-check-resolved":
      return `${lead} The booking was then marked resolved under "Card refunds paid back twice"${note.resolutionNote ? `, with the note: "${note.resolutionNote}"` : ""}. If the member returned the extra, they are owed ${note.check} again: it is listed under ${GAVE_UP_ON} and is not asked for again automatically, so pay them another way and close it there. If they kept it, ask a developer to reconcile the row.`;
  }
}
