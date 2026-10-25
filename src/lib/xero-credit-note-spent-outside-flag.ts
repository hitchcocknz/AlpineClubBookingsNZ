/**
 * #4220 (lane a): the early warning that Xero shows a credit note spent on
 * something the app has no record of, while the ledger still counts that credit
 * as a booking's. Read-only and derived on every ask: it writes no ledger row,
 * no Xero object and no stored flag, sends no email, and makes no Xero call. The
 * reading it judges is the one kept at ingest (`xero-credit-note-spend-evidence.ts`).
 *
 * IT USES THE SAME COMPARATOR AS THE WRITERS (`INV-SSOT`), so it flags exactly
 * what they would leave undone and nothing else: Xero's list must account for
 * what the note has lost (`spendIsExplained`), the app's own entries are taken out
 * (`outsideSpendCents`), the note must be active and settled (`ACTIVE_NOTE_STATUSES`,
 * `CREDIT_NOTE_MIRROR_SETTLE_MS`), and the cents are planned by `planOutsideSpendMirror`.
 * The inbound mirror (#4270) writes down the part of the lot no booking has drawn; what
 * it leaves, `leftForAllocationCents`, is credit already drawn onto a booking, and that
 * is what is flagged: the booking's allocation will be refused by Xero (#4218). A note
 * that is inactive, unexplained, unsettled, shared by several lots, unreadable or
 * missing a reading flags nothing, so a Xero outage or a half-written list never
 * raises a false alarm.
 *
 * The flag lags Xero by the webhook and cursor-sync delay: a spend shows up when
 * the note's next event is reconciled, and a reversal clears the same way.
 */
import type { Prisma } from "@prisma/client";
import { memberCreditBalanceCents } from "@/lib/member-credit-booking-rows";
import { planOutsideSpendMirror } from "@/lib/xero-credit-note-mirror-plan";
import {
  ACTIVE_NOTE_STATUSES,
  CREDIT_NOTE_MIRROR_SETTLE_MS,
  outsideSpendCents,
  spendIsExplained,
} from "@/lib/xero-credit-note-outside-spend";
import {
  CREDIT_NOTE_SPEND_EVIDENCE_KEY,
  readStoredSpendEvidence,
  type ReadCreditNoteSpendEvidence,
} from "@/lib/xero-credit-note-spend-evidence";
import { NOT_A_CONVERGENCE_ROW, writtenDownCentsByCreditNote } from "@/lib/xero-credit-note-write-down";

export type SpentOutsideAppDb = Pick<
  Prisma.TransactionClient,
  "xeroObjectLink" | "memberCredit" | "memberCreditNoteAllocation" | "payment"
>;

/** One credit note Xero shows spent outside the app, with credit still drawn onto bookings. */
export interface CreditNoteSpentOutsideApp {
  creditNoteId: string;
  memberId: string;
  lotId: string;
  lotCents: number;
  /** What Xero shows spent on things the app has no record of. */
  outsideSpendCents: number;
  /** Net already written down for the note. */
  writtenDownCents: number;
  /** Credit Xero shows gone that the ledger still counts as drawn onto a booking. */
  leftForAllocationCents: number;
  /** The bookings that hold a slice of the lot. */
  bookingIds: string[];
  observedAt: Date;
}

/**
 * Whether a reading can be judged at all: active, accounted for, and settled.
 * Exactly the mirror's own gates, in the mirror's order.
 */
export function spendReadingIsJudgeable(reading: ReadCreditNoteSpendEvidence, now: Date): boolean {
  if (!reading.status || !ACTIVE_NOTE_STATUSES.includes(reading.status)) return false;
  if (!spendIsExplained(reading)) return false;
  if (!reading.updatedAt) return false;
  return reading.updatedAt.getTime() + CREDIT_NOTE_MIRROR_SETTLE_MS <= now.getTime();
}

/** Spend Xero lists at all: a note with none cannot be flagged, and its lookups are skipped. */
function listsAnySpend(reading: ReadCreditNoteSpendEvidence): boolean {
  return reading.allocations.length + reading.payments.length > 0;
}

/**
 * Every credit note Xero shows spent outside the app that the ledger has not
 * absorbed, for these bookings, or for all of them when no booking is named.
 * Database reads only.
 */
export async function findCreditNotesSpentOutsideApp(
  db: SpentOutsideAppDb,
  options: { bookingIds?: readonly string[]; now?: Date } = {},
): Promise<CreditNoteSpentOutsideApp[]> {
  const now = options.now ?? new Date();

  const slices = await db.memberCreditNoteAllocation.findMany({
    where: options.bookingIds ? { appliedToBookingId: { in: [...options.bookingIds] } } : {},
    select: { memberCreditId: true, appliedToBookingId: true },
  });
  if (slices.length === 0) return [];
  const bookingsByLot = new Map<string, Set<string>>();
  for (const slice of slices) {
    bookingsByLot.set(slice.memberCreditId, (bookingsByLot.get(slice.memberCreditId) ?? new Set()).add(slice.appliedToBookingId));
  }

  const lots = await db.memberCredit.findMany({
    where: { id: { in: [...bookingsByLot.keys()] }, xeroCreditNoteId: { not: null }, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    select: { id: true, memberId: true, amountCents: true, xeroCreditNoteId: true },
  });
  const noteIds = [...new Set(lots.flatMap((lot) => (lot.xeroCreditNoteId ? [lot.xeroCreditNoteId] : [])))];
  if (noteIds.length === 0) return [];

  // The note's funding lots, whatever bookings draw on them: a note that funds more than one lot is left alone.
  const fundingLots = await db.memberCredit.groupBy({
    by: ["xeroCreditNoteId"],
    where: { xeroCreditNoteId: { in: noteIds }, amountCents: { gt: 0 }, ...NOT_A_CONVERGENCE_ROW },
    _count: { _all: true },
  });
  const sharedNotes = new Set(fundingLots.filter((row) => row._count._all > 1).flatMap((row) => (row.xeroCreditNoteId ? [row.xeroCreditNoteId] : [])));

  const links = await db.xeroObjectLink.findMany({
    where: {
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: { in: noteIds },
      active: true,
      metadata: { path: [CREDIT_NOTE_SPEND_EVIDENCE_KEY, "totalCents"], gte: 0 },
    },
    select: { xeroObjectId: true, metadata: true },
  });
  const readingByNote = new Map<string, ReadCreditNoteSpendEvidence>();
  for (const link of links) {
    const reading = readStoredSpendEvidence(link.metadata);
    const kept = readingByNote.get(link.xeroObjectId);
    if (reading && (!kept || reading.observedAt.getTime() > kept.observedAt.getTime())) readingByNote.set(link.xeroObjectId, reading);
  }

  const sliceTotals = await db.memberCreditNoteAllocation.groupBy({
    by: ["memberCreditId"],
    where: { memberCreditId: { in: lots.map((lot) => lot.id) } },
    _sum: { amountCents: true },
  });
  const slicedByLot = new Map(sliceTotals.map((row) => [row.memberCreditId, row._sum.amountCents ?? 0]));

  const found: CreditNoteSpentOutsideApp[] = [];
  for (const lot of lots) {
    const noteId = lot.xeroCreditNoteId;
    const reading = noteId ? readingByNote.get(noteId) : undefined;
    if (!noteId || !reading || sharedNotes.has(noteId)) continue;
    if (!spendReadingIsJudgeable(reading, now) || !listsAnySpend(reading)) continue;

    const outsideCents = await outsideSpendCents(db, reading.allocations, reading.payments);
    if (outsideCents <= 0) continue;
    const writtenDownCents = (await writtenDownCentsByCreditNote(db, lot.memberId, [noteId])).get(noteId) ?? 0;
    const plan = planOutsideSpendMirror({
      lotCents: lot.amountCents,
      sliceCents: slicedByLot.get(lot.id) ?? 0,
      writtenDownCents,
      outsideSpendCents: outsideCents,
      balanceCents: await memberCreditBalanceCents(db, lot.memberId),
    });
    if (plan.leftForAllocationCents <= 0) continue;
    found.push({
      creditNoteId: noteId,
      memberId: lot.memberId,
      lotId: lot.id,
      lotCents: lot.amountCents,
      outsideSpendCents: outsideCents,
      writtenDownCents,
      leftForAllocationCents: plan.leftForAllocationCents,
      bookingIds: [...(bookingsByLot.get(lot.id) ?? [])].sort(),
      observedAt: reading.observedAt,
    });
  }
  return found;
}
