/**
 * The pure applied-credit allocation planner (#1620), split from
 * `xero-applied-credit-allocation.ts` (#3836) so the engine stays within its
 * size budget. Unit-tested; the engine re-exports it.
 */
import type { CreditType, Prisma } from "@prisma/client";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Credit-lot use order (INV-PAY-127, #4013)
// ---------------------------------------------------------------------------

/**
 * The ONE order in which a member's positive credit lots are used: oldest
 * first, and between two lots stamped with the same instant, the lower `id`
 * first. Every read that hands lots to {@link planAppliedCreditAllocation}
 * orders by this and by nothing else (`INV-PAY-127`), and
 * `credit-lot-use-order-census.test.ts` fails a `memberCredit` read that orders
 * by `createdAt` any other way.
 *
 * `createdAt` alone is not an order. Two lots written in one transaction, or
 * under the frozen test clock, carry the same instant, and PostgreSQL returns
 * tied rows in whatever order its plan meets them: a noted lot one run and a
 * noteless one the next, which decides whether the engine allocates an existing
 * note or mints a remainder (#4013). The `id` tie-break changes no amount and no
 * lot's eligibility; it only makes the tie the same every time. Spread it into
 * the query (`orderBy: [...CREDIT_LOT_USE_ORDER]`) — Prisma takes a mutable
 * array and this one stays frozen.
 */
export const CREDIT_LOT_USE_ORDER = [
  { createdAt: "asc" },
  { id: "asc" },
] as const satisfies readonly Prisma.MemberCreditOrderByWithRelationInput[];

// ---------------------------------------------------------------------------
// Pure allocation planner (unit-tested)
// ---------------------------------------------------------------------------

export interface AppliedCreditLot {
  memberCreditId: string;
  /** The lot's floating Xero note, or null for a noteless lot (admin adjustment
   * or #1547-restored credit) that must be covered by a freshly minted note. */
  xeroCreditNoteId: string | null;
  /**
   * The ledger row's own credit type. REQUIRED (#2717): it is what decides
   * which Xero mapping a MINTED slice of this lot posts to, and "noteless"
   * does not answer that — an admin adjustment and #1547-restored cancellation
   * credit are both noteless and are opposite accounting events. Making it a
   * required field rather than an optional hint is deliberate: a caller that
   * forgets it cannot compile, so a new lot loader cannot silently book a
   * member's own refunded money as a discretionary club expense.
   */
  creditType: CreditType;
  /** lot.amountCents − Σ already-allocated slices (>= 0). */
  remainingCents: number;
}

export interface PlannedNoteAllocation {
  memberCreditId: string;
  xeroCreditNoteId: string;
  amountCents: number;
}

export interface PlannedMintSlice {
  memberCreditId: string;
  /** Carried from the lot — see `AppliedCreditLot.creditType` (#2717). */
  creditType: CreditType;
  amountCents: number;
}

export interface AppliedCreditPlan {
  /** Existing floating notes to allocate against the invoice. */
  noteAllocations: PlannedNoteAllocation[];
  /** Noteless lots to cover with a single freshly minted note. */
  mintSlices: PlannedMintSlice[];
  /** Σ mintSlices — the amount of the fresh note to mint (0 when none). */
  mintTotalCents: number;
  /** Total planned; always equals appliedCents for a well-formed ledger. */
  coveredCents: number;
}

/**
 * Decide which credit lots fund `appliedCents`, in the order given — which the
 * loader makes {@link CREDIT_LOT_USE_ORDER}. Conservation is independent of lot
 * order (owner/advisor: lot order is neutral); oldest-first, ties by `id`, is
 * the deterministic default. Throws if the lots cannot cover the applied amount —
 * that can only happen on a corrupted ledger, since applied credit never exceeds
 * the balance at apply-time and allocations never exceed prior applications.
 */
export function planAppliedCreditAllocation(
  lots: AppliedCreditLot[],
  appliedCents: number,
  format: ClubFormat,
): AppliedCreditPlan {
  const noteAllocations: PlannedNoteAllocation[] = [];
  const mintSlices: PlannedMintSlice[] = [];
  let outstanding = appliedCents;

  for (const lot of lots) {
    if (outstanding <= 0) {
      break;
    }
    const slice = Math.min(lot.remainingCents, outstanding);
    if (slice <= 0) {
      continue;
    }
    if (lot.xeroCreditNoteId) {
      noteAllocations.push({
        memberCreditId: lot.memberCreditId,
        xeroCreditNoteId: lot.xeroCreditNoteId,
        amountCents: slice,
      });
    } else {
      mintSlices.push({
        memberCreditId: lot.memberCreditId,
        creditType: lot.creditType,
        amountCents: slice,
      });
    }
    outstanding -= slice;
  }

  if (outstanding > 0) {
    throw new Error(
      `Applied credit ${formatCents(appliedCents, format)} exceeds available credit-lot remaining by ${formatCents(outstanding, format)} — member-credit ledger inconsistency`,
    );
  }

  const mintTotalCents = mintSlices.reduce((sum, m) => sum + m.amountCents, 0);
  return {
    noteAllocations,
    mintSlices,
    mintTotalCents,
    coveredCents: appliedCents - outstanding,
  };
}

// ---------------------------------------------------------------------------
// Ledger reads
// ---------------------------------------------------------------------------
