import { useMemo } from "react";
import type { PromoPreviewEditRerates } from "@/components/promo-preview-guest";

/**
 * #4202: the officer re-rates an edit sends, built ONCE for the quote and save
 * payload and for the promo box, so the box clears the same guests' locked
 * prices as the quote. The other-lodge election travels only when the edit
 * changes it (`payloadFields` answers `{}` otherwise: an unchanged one would
 * re-reprice those guests on every ordinary edit); the #2337
 * placeholder→member links are keyed to existing guest rows.
 */
export function useEditRerates(
  linkedGuestMembers: Readonly<Record<string, { memberId: string }>>,
  otherLodgePayloadFields: () => Omit<PromoPreviewEditRerates, "linkGuestToMember">,
): PromoPreviewEditRerates {
  return useMemo(() => {
    const links = Object.entries(linkedGuestMembers).map(([guestId, candidate]) => ({
      guestId,
      memberId: candidate.memberId,
    }));
    return {
      ...otherLodgePayloadFields(),
      ...(links.length > 0 ? { linkGuestToMember: links } : {}),
    };
  }, [linkedGuestMembers, otherLodgePayloadFields]);
}
