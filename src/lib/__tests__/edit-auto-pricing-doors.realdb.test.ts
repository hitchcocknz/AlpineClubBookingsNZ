/**
 * Real-PostgreSQL proof for #4317 (epic #4302): every booking edit door PRICES an
 * edit from stored data, and none sends it to an officer.
 *
 * Each case is a shape that #3031/#3166/#3170 PARKED as an `EDIT_FINANCIAL_REVIEW`
 * task, driven through the REAL door against real rows, with the dollar answer
 * the `valueStrandNights` rule (`INV-MOD-028`, owner decision D1) gives:
 *
 *  - the guest removal (`removeBookingGuestInTransaction`): T2 beside a
 *    companion with blank rows (T8), with the ledger posting the reversal;
 *  - the date change (`modifyBookingDates`): a shortening that keeps a blank
 *    night at its valued share (T7/T8), and a whole-stay move that buys every
 *    night fresh and is charged the ordinary change fee (T5, D8);
 *  - the batch edit (`modifyBookingBatch`): a guest added beside an existing
 *    guest with no usable rows (T1/T8), an extension of that guest (T4), and an
 *    in-progress shortening of a strand whose rows reach past its stored
 *    `stayEnd` (T6) beside one whose rows do not add up (T9).
 *
 * Every case also asserts that no `ManualRefundTask` was written.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`, against
 * a loopback database on port 55442+ named with `concurrency_race_1881`.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/edit-auto-pricing-doors.realdb.test.ts
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4317-owner";
const OFFICER_ID = "race-4317-officer";
const LODGE_ID = "race-4317-lodge";
const SEASON_ID = "race-4317-season";
const BOOKING_ID = "race-4317-booking";
const GUEST_A = "race-4317-guest-a";
const GUEST_B = "race-4317-guest-b";

/** Today's season rate for a non-member adult. */
const RATE = 5_000;
/** The frozen suite clock's day. */
const TODAY = new Date("2026-07-01T00:00:00.000Z");
const D = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** The sibling harness's envelope, re-declared so running this file alone registers no other suite. */
function assertSafeRaceDbUrl(url: string): void {
  const parsed = new URL(url);
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(`Refusing port ${parsed.port || "(none)"}: use a throwaway Postgres on 55442+.`);
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("The race DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname).includes("concurrency_race_1881")) {
    throw new Error("The race DB name must carry 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let dateService: typeof import("@/lib/booking-date-modification-service");
let removalService: typeof import("@/lib/booking-guest-removal-service");
let clubTimeServer: typeof import("@/lib/club-time/server");
const pendingXeroWork: Promise<unknown>[] = [];
let restoreXeroQueue: (() => void) | undefined;

type SeedNight = { day: string; cents: number | null };
type SeedGuest = {
  id: string;
  total: number;
  nights: SeedNight[];
  /** The stored envelope, when it should differ from the rows (T6). */
  stayEnd?: string;
};

async function modificationIds(): Promise<string[]> {
  const rows = await prisma.bookingModification.findMany({ where: { bookingId: BOOKING_ID }, select: { id: true } });
  return rows.map((row) => row.id);
}

async function clean(): Promise<void> {
  const errors: unknown[] = [];
  while (pendingXeroWork.length > 0) {
    for (const result of await Promise.allSettled(pendingXeroWork.splice(0))) {
      if (result.status === "rejected") errors.push(result.reason);
    }
  }
  const localIds = [BOOKING_ID, ...(await modificationIds())];
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { actorMemberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.payment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNightAdjustment.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
  if (errors.length > 0) {
    throw new AggregateError(errors, "#4317: a fixture's Xero enqueue failed; all work drained and owned fixtures cleaned");
  }
}

/** One booking, its guests and their rows, exactly as stored. */
async function seed(options: {
  checkIn: string;
  checkOut: string;
  status: "CONFIRMED" | "PAID" | "PAYMENT_PENDING";
  guests: SeedGuest[];
}): Promise<void> {
  const total = options.guests.reduce((sum, guest) => sum + guest.total, 0);
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: D(options.checkIn),
      checkOut: D(options.checkOut),
      status: options.status,
      totalPriceCents: total,
      finalPriceCents: total,
      hasNonMembers: true,
    },
  });
  for (const guest of options.guests) {
    const days = guest.nights.map((night) => night.day).sort();
    const lastNight = D(days[days.length - 1]!);
    await prisma.bookingGuest.create({
      data: {
        id: guest.id,
        bookingId: BOOKING_ID,
        firstName: "Guest",
        lastName: guest.id.slice(-1).toUpperCase(),
        ageTier: "ADULT",
        isMember: false,
        stayStart: D(days[0]!),
        stayEnd: guest.stayEnd ? D(guest.stayEnd) : new Date(lastNight.getTime() + 86_400_000),
        priceCents: guest.total,
        nights: {
          create: guest.nights.map((night) => ({
            stayDate: D(night.day),
            priceCents: night.cents,
            priceSource: night.cents === null ? ("UNKNOWN" as const) : ("SOLD" as const),
          })),
        },
      },
    });
  }
}

/** The booking's confirmation lines for one guest's priced nights, as the settle posts them. */
async function confirmGuest(guestId: string, nights: SeedNight[]): Promise<void> {
  for (const night of nights) {
    if (night.cents === null) continue;
    await prisma.bookingLedgerLine.create({
      data: {
        bookingId: BOOKING_ID,
        side: "CHARGE",
        kind: "GUEST_NIGHT",
        sign: 1,
        quantity: 1,
        unitCents: night.cents,
        amountCents: night.cents,
        bookingGuestId: guestId,
        nightStart: D(night.day),
        nightEndExclusive: new Date(D(night.day).getTime() + 86_400_000),
        ageTier: "ADULT",
        guestNames: [guestId],
        anchorKind: "CONFIRMATION",
        anchorId: BOOKING_ID,
        narration: "race 4317 confirmation",
        lodgeId: LODGE_ID,
        postingKey: `race-4317-confirm-${guestId}-${night.day}`,
      },
    });
  }
}

async function guestRow(id: string) {
  return prisma.bookingGuest.findUniqueOrThrow({
    where: { id },
    include: { nights: { orderBy: { stayDate: "asc" } } },
  });
}

async function rowsOf(id: string) {
  return (await guestRow(id)).nights.map((night) => [
    night.stayDate.toISOString().slice(0, 10),
    night.priceCents,
    night.priceSource,
  ]);
}

async function booking() {
  return prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } });
}

async function noReviewRaised(): Promise<void> {
  expect(await prisma.manualRefundTask.count({ where: { bookingId: BOOKING_ID } })).toBe(0);
}

async function batch(input: Record<string, unknown>) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor: { id: OFFICER_ID, role: Role.ADMIN },
    input: input as never,
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

async function removeGuest(guestId: string) {
  return prisma.$transaction(
    (tx) =>
      removalService.removeBookingGuestInTransaction({
        tx,
        bookingId: BOOKING_ID,
        guestId,
        actorMemberId: OFFICER_ID,
        actorRole: "ADMIN",
        today: TODAY,
        format: CLUB_FORMAT_TEST,
      }),
    { maxWait: 10_000, timeout: 20_000 },
  );
}

(RUN ? describe : describe.skip)(
  "#4317: every edit door prices from stored data and raises no review - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      batchService = await import("@/lib/booking-batch-modification-service");
      dateService = await import("@/lib/booking-date-modification-service");
      removalService = await import("@/lib/booking-guest-removal-service");
      clubTimeServer = await import("@/lib/club-time/server");
      const xeroQueue = await import("@/lib/xero-booking-edit-settlement");
      const queue = xeroQueue.queueXeroBookingEditSettlement;
      const spy = vi.spyOn(xeroQueue, "queueXeroBookingEditSettlement").mockImplementation((input) => {
        const pending = queue(input);
        if (input.bookingId === BOOKING_ID) pendingXeroWork.push(pending);
        return pending;
      });
      restoreXeroQueue = () => spy.mockRestore();

      await clean();
      await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
      await prisma.season.deleteMany({ where: { id: SEASON_ID } });
      await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
      await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });

      for (const [id, role] of [
        [OWNER_ID, Role.USER],
        [OFFICER_ID, Role.ADMIN],
      ] as const) {
        await prisma.member.create({
          data: {
            id,
            email: `${id}@example.invalid`,
            passwordHash: "not-a-real-password",
            firstName: id === OWNER_ID ? "Owner" : "Officer",
            lastName: "Proof",
            ageTier: "ADULT",
            canLogin: true,
            role,
          },
        });
      }
      await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4317 Lodge", slug: "race-4317" } });
      await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 20 } });
      // 45+ days out refunds in full; closer keeps half. A move from inside 45
      // days to outside it is to a more lenient tier, so it carries a fee (D8).
      await prisma.cancellationPolicy.createMany({
        data: [
          { lodgeId: LODGE_ID, daysBeforeStay: 45, refundPercentage: 100, creditRefundPercentage: 100 },
          { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 },
        ],
      });
      const nonMember = await prisma.membershipType.findUniqueOrThrow({ where: { key: "NON_MEMBER" } });
      await prisma.season.create({
        data: {
          id: SEASON_ID,
          name: "Race 4317 season",
          type: "WINTER",
          startDate: D("2026-06-01"),
          endDate: D("2026-09-30"),
          active: true,
          lodgeId: LODGE_ID,
          membershipTypeRates: {
            create: [
              { membershipTypeId: nonMember.id, ageTier: "ADULT", pricePerNightCents: RATE },
              { membershipTypeId: nonMember.id, ageTier: null, pricePerNightCents: RATE },
            ],
          },
        },
      });
    }, 120_000);

    beforeEach(async () => {
      await clean();
    });

    afterAll(async () => {
      try {
        if (!prisma) return;
        await clean();
        await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
        await prisma.season.deleteMany({ where: { id: SEASON_ID } });
        await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
        await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
        await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
        await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
        await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
      } finally {
        restoreXeroQueue?.();
      }
    });

    it("guest removal T2/T8: credits the departing guest's $120 beside a companion with blank rows, and posts the reversal", async () => {
      const leaving: SeedNight[] = [
        { day: "2026-08-10", cents: 6_000 },
        { day: "2026-08-11", cents: 6_000 },
      ];
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "CONFIRMED",
        guests: [
          { id: GUEST_A, total: 12_000, nights: leaving },
          // No usable rows: valued at $50 each (R2) from its stored $100.
          { id: GUEST_B, total: 10_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });
      await confirmGuest(GUEST_A, leaving);

      const result = await removeGuest(GUEST_A);

      expect(result.priceDiffCents).toBe(-12_000);
      expect((await booking()).totalPriceCents).toBe(10_000);
      expect((await booking()).finalPriceCents).toBe(10_000);
      // The companion keeps its stored total, and a removal rewrites nobody
      // else's rows: its blanks are left as they were.
      expect((await guestRow(GUEST_B)).priceCents).toBe(10_000);
      expect(await rowsOf(GUEST_B)).toEqual([
        ["2026-08-10", null, "UNKNOWN"],
        ["2026-08-11", null, "UNKNOWN"],
      ]);
      await noReviewRaised();
      // The ledger reverses the departing guest's two confirmation lines.
      const reversals = await prisma.bookingLedgerLine.findMany({
        where: { bookingId: BOOKING_ID, reversesLineId: { not: null } },
      });
      expect(reversals.map((line) => line.sign * line.unitCents * line.quantity)).toEqual([-6_000, -6_000]);
    });

    // D11 (a negative stored total valued at $0) is NOT exercised here, and
    // cannot be: `BookingGuest_price_nonnegative` (#2797, NOT VALID) refuses a
    // negative total on every INSERT and UPDATE, and the 11 Aug 2026 audit
    // measured the existing population at zero. The rule is pinned at the
    // planner and door unit level (`booking-edit-guest-ranges-sparse`,
    // `booking-guest-consent-authority`, `booking-edit-quote-save-parity`).

    it("date change T7/T8: a shortening keeps the blank night at its $50 share and credits the $40 night given back", async () => {
      // $40 + blank + $40 against a stored $130: the blank is worth $50 (R2).
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
        status: "PAYMENT_PENDING",
        guests: [
          {
            id: GUEST_A,
            total: 13_000,
            nights: [
              { day: "2026-08-10", cents: 4_000 },
              { day: "2026-08-11", cents: null },
              { day: "2026-08-12", cents: 4_000 },
            ],
          },
        ],
      });

      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-10", checkOut: "2026-08-12" } as never,
        ipAddress: "127.0.0.1",
      });

      expect(result.priceDiffCents).toBe(-4_000);
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_000, "SOLD"],
        ["2026-08-11", 5_000, "EVEN_SPLIT"],
      ]);
      await noReviewRaised();
    });

    it("date change T5/D8: a whole-stay move buys every night fresh and is charged the ordinary change fee", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-13",
        status: "PAYMENT_PENDING",
        guests: [
          {
            id: GUEST_A,
            total: 13_000,
            nights: [
              { day: "2026-08-10", cents: 4_000 },
              { day: "2026-08-11", cents: null },
              { day: "2026-08-12", cents: 4_000 },
            ],
          },
        ],
      });

      const result = await dateService.modifyBookingDates({
        bookingId: BOOKING_ID,
        actor: { id: OFFICER_ID, role: Role.ADMIN },
        input: { checkIn: "2026-08-20", checkOut: "2026-08-23" } as never,
        ipAddress: "127.0.0.1",
      });

      // The stored $130 is given back and three nights bought at $50: +$20.
      expect(result.priceDiffCents).toBe(2_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-20", RATE, "SOLD"],
        ["2026-08-21", RATE, "SOLD"],
        ["2026-08-22", RATE, "SOLD"],
      ]);
      // 40 days out to 50 days out crosses into the 100% tier: half the
      // original $130 is the fee, charged as on any edit (D8).
      expect(result.changeFeeCents).toBe(6_500);
      await noReviewRaised();
    });

    it("batch T1/T8: a guest added beside a strand with no usable rows charges exactly the added guest", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "PAYMENT_PENDING",
        guests: [
          { id: GUEST_A, total: 9_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });

      const result = await batch({
        addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false }],
      });

      expect(result.priceDiffCents).toBe(2 * RATE);
      expect((await booking()).totalPriceCents).toBe(9_000 + 2 * RATE);
      // The existing guest keeps its $90, its blanks written at their $45 share.
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_500, "EVEN_SPLIT"],
        ["2026-08-11", 4_500, "EVEN_SPLIT"],
      ]);
      await noReviewRaised();
    });

    it("batch T4: an extension of a strand with no usable rows buys only the new night", async () => {
      await seed({
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        status: "PAYMENT_PENDING",
        guests: [
          { id: GUEST_A, total: 9_000, nights: [{ day: "2026-08-10", cents: null }, { day: "2026-08-11", cents: null }] },
        ],
      });

      const result = await batch({ checkOut: "2026-08-13" });

      expect(result.priceDiffCents).toBe(RATE);
      expect((await guestRow(GUEST_A)).priceCents).toBe(9_000 + RATE);
      expect(await rowsOf(GUEST_A)).toEqual([
        ["2026-08-10", 4_500, "EVEN_SPLIT"],
        ["2026-08-11", 4_500, "EVEN_SPLIT"],
        ["2026-08-12", RATE, "SOLD"],
      ]);
      await noReviewRaised();
    });

    it("batch in progress T6/T9: a shortening prices a strand whose rows outrun its stayEnd and one whose rows do not add up", async () => {
      // Under way: the frozen day is 1 July, so the edit window opens on 2 July.
      const run = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];
      await seed({
        checkIn: "2026-06-29",
        checkOut: "2026-07-03",
        status: "PAID",
        guests: [
          // T6: four $50 rows, but the stored stayEnd stops a morning short.
          { id: GUEST_A, total: 20_000, nights: run.map((day) => ({ day, cents: RATE })), stayEnd: "2026-07-02" },
          // T9: four $50 rows against a stored $201.01 — R3 splits the total:
          // $50.26, $50.25, $50.25, $50.25.
          { id: GUEST_B, total: 20_101, nights: run.map((day) => ({ day, cents: RATE })) },
        ],
      });

      const result = await batch({ checkOut: "2026-07-02", settlementMethod: "card" });

      // The 2nd is given back: $50 from A, $50.25 from B.
      expect(result.priceDiffCents).toBe(-(RATE + 5_025));
      expect((await guestRow(GUEST_A)).priceCents).toBe(3 * RATE);
      expect((await guestRow(GUEST_B)).priceCents).toBe(20_101 - 5_025);
      expect((await rowsOf(GUEST_B)).map((row) => row[1])).toEqual([5_026, 5_025, 5_025]);
      await noReviewRaised();
    });
  },
);
