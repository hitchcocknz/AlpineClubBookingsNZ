import { GroupBookingStatus, type Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES } from "@/lib/booking-status";

/**
 * #3949 (`INV-PAY-136`, review rounds 3 and 4): IS THE ORGANISER'S GROUP CANCEL BETWEEN ITS PLAN AND THIS CHILD'S
 * CLAIM? The cancel fences the group CANCELLED under `lock(1)`, then freezes each child's refund outside it from the
 * payment as it stood, net of the hand-backs then open, and books that whole planned share - on the mirror, the
 * ledger and the organiser's hand-back - when it claims the child under `lock(1)`. Until that claim (or the reaper's
 * resume of it) has cancelled the child, the child is still one the cancel will claim
 * (`ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES`) in a CANCELLED group.
 *
 * The ONE test for the refusals that keep a refund to the organiser off a child in that window, so it is never paid
 * twice: a hand-back's completion (`group-settlement-mirror-hand-back.ts`) and the raising of a new one by any edit
 * door or an approved appeal (`edit-refund-hand-back.ts`). Asked under the caller's `lock(1)` - the fence's and the
 * claim's own key - with the child's status as read under it, so the answer holds until the caller commits.
 */
export async function groupCancelInProgress(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  child: { status: string; parentBookingId: string | null },
): Promise<boolean> {
  if (!child.parentBookingId || !(ORGANISER_CANCEL_ACTIVE_CHILD_STATUSES as readonly string[]).includes(child.status)) return false;
  const group = await store.groupBooking.findUnique({ where: { organiserBookingId: child.parentBookingId }, select: { status: true } });
  return group?.status === GroupBookingStatus.CANCELLED;
}

/** #3949 review round 4: the refusal an edit or an appeal meets when it would raise a new refund to the organiser in that window. */
export const GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE =
  "The group organiser is cancelling this group and has not finished with this booking yet, so no refund to the organiser can be raised on it now: the cancellation is working out this booking's own refund to the organiser from the price as it stood. Wait until the booking shows as cancelled, then decide whether anything more is owed.";

/** Thrown inside the edit's or the approval's transaction, so the whole change rolls back; the doors answer 409. */
export class GroupCancelInProgressError extends ApiError {
  constructor() {
    super(GROUP_CANCEL_IN_PROGRESS_RAISE_MESSAGE, 409);
  }
}
