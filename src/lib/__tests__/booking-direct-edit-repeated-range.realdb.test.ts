/**
 * Real-PostgreSQL proof for #4189: a direct booking edit in the editor's range
 * mode (per-guest dates on, night grid off) keeps an untouched gapped guest's
 * nights, and charges nothing for their gaps (`INV-MOD-062`).
 *
 * Range mode sends EVERY remaining guest's Date In and Date Out and cannot carry
 * a gap (#713). Before #4189 the shared stay-range resolver normalised a guest's
 * own dates sent back unchanged into one continuous range, so the canonical
 * `modifyBookingBatch` put a guest holding the 10th and 12th on the 11th too,
 * and charged it. The rule is #4157's (`nightsKeptByRepeatedRange`, owner
 * decision "Keep their nights"): only a moved bound re-spreads a guest.
 *
 * Every step is the REAL code: `modifyBookingBatch` under its own locks, the real
 * pricing tables and the real night-row writes. The claims:
 *
 *  1. An officer's range-mode edit that adds a guest and repeats everyone
 *     else's dates charges only the added guest's nights; the gapped guest's
 *     night rows are byte-identical.
 *  2. A member's range-mode edit of a mixed party: the repeated gapped guest
 *     keeps their nights, while the gapped guest whose Date In really moved is
 *     re-spread over a continuous stay and charged for the night it gains.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-4189-` fixtures.
 */
import { Role, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const OWNER_ID = "race-4189-owner";
const OFFICER_ID = "race-4189-officer";
const LODGE_ID = "race-4189-lodge";
const SEASON_ID = "race-4189-season";
const BOOKING_ID = "race-4189-booking";
const OWNER_GUEST_ID = "race-4189-owner-guest";
const GAPPED_ID = "race-4189-gapped";
const GAPPED_2_ID = "race-4189-gapped-2";
// Future against the frozen suite clock (1 July 2026): 10-13 September.
const CHECK_IN = new Date("2026-09-10T00:00:00.000Z");
const GAP_NIGHT = new Date("2026-09-11T00:00:00.000Z");
const LAST_NIGHT = new Date("2026-09-12T00:00:00.000Z");
const CHECK_OUT = new Date("2026-09-13T00:00:00.000Z");
const OWN_DATES = { stayStart: "2026-09-10", stayEnd: "2026-09-13" };
const NIGHT_CENTS = 5_000;
const STORED_NIGHT_CENTS = 4_321; // deliberately NOT the season rate

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeDirectEditRepeatedRangeRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Direct-edit repeated-range proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run direct-edit repeated-range proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Direct-edit repeated-range proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Direct-edit repeated-range proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let batchService: typeof import("@/lib/booking-batch-modification-service");
let clubTimeServer: typeof import("@/lib/club-time/server");

async function clean(): Promise<void> {
  const modifications = await prisma.bookingModification.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true },
  });
  await prisma.xeroSyncOperation.deleteMany({
    where: { localId: { in: [BOOKING_ID, ...modifications.map((row) => row.id)] } },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { targetId: BOOKING_ID },
        { memberId: { in: [OWNER_ID, OFFICER_ID] } },
        { subjectMemberId: OWNER_ID },
      ],
    },
  });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.memberCredit.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId: OWNER_ID } });
  await prisma.hostingCoverageIncident.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/** A guest row with one SOLD night row per night it holds. */
async function storedGuest(
  id: string,
  firstName: string,
  nights: Date[],
  member?: { memberId: string },
): Promise<void> {
  await prisma.bookingGuest.create({
    data: {
      id,
      bookingId: BOOKING_ID,
      firstName,
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: Boolean(member),
      memberId: member?.memberId ?? null,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: nights.length * STORED_NIGHT_CENTS,
      nights: {
        create: nights.map((stayDate) => ({ stayDate, priceCents: STORED_NIGHT_CENTS, priceSource: "SOLD" as const })),
      },
    },
  });
}

/**
 * An unpaid 10-13 September stay: the owner for all three nights, and two
 * guests who each hold the 10th and the 12th only (a gap on the 11th, #713).
 */
async function seed(): Promise<void> {
  const totalCents = (3 + 2 + 2) * STORED_NIGHT_CENTS;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: OWNER_ID,
      lodgeId: LODGE_ID,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      status: "PAYMENT_PENDING",
      totalPriceCents: totalCents,
      finalPriceCents: totalCents,
    },
  });
  await storedGuest(OWNER_GUEST_ID, "Owner", [CHECK_IN, GAP_NIGHT, LAST_NIGHT], { memberId: OWNER_ID });
  await storedGuest(GAPPED_ID, "Gapped", [CHECK_IN, LAST_NIGHT]);
  await storedGuest(GAPPED_2_ID, "Second", [CHECK_IN, LAST_NIGHT]);
}

/** Each guest's night rows, as `[stayDate, priceCents, priceSource]`. */
async function nightsOf(id: string) {
  const guest = await prisma.bookingGuest.findUniqueOrThrow({
    where: { id },
    include: { nights: { orderBy: { stayDate: "asc" } } },
  });
  return guest.nights.map((night) => [night.stayDate.toISOString().slice(0, 10), night.priceCents, night.priceSource]);
}

async function edit(actor: { id: string; role: Role }, input: Record<string, unknown>) {
  return batchService.modifyBookingBatch({
    bookingId: BOOKING_ID,
    actor,
    input: input as Parameters<typeof batchService.modifyBookingBatch>[0]["input"],
    ipAddress: "127.0.0.1",
    todayAtClub: (await clubTimeServer.clubTime()).today(),
    format: CLUB_FORMAT_TEST,
  });
}

(RUN ? describe : describe.skip)("a range-mode direct edit keeps an untouched gapped guest's nights, on PostgreSQL (#4189)", () => {
  beforeAll(async () => {
    assertSafeDirectEditRepeatedRangeRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
    batchService = await import("@/lib/booking-batch-modification-service");
    clubTimeServer = await import("@/lib/club-time/server");

    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });

    for (const [id, firstName, role] of [
      [OWNER_ID, "Owner", Role.USER],
      [OFFICER_ID, "Officer", Role.ADMIN],
    ] as const) {
      await prisma.member.create({
        data: {
          id,
          email: `${id}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName,
          lastName: "Proof",
          ageTier: "ADULT",
          canLogin: true,
          role,
        },
      });
    }
    await prisma.memberAccessRole.create({ data: { memberId: OFFICER_ID, role: "ADMIN" } });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4189 Lodge", slug: "race-4189" } });
    await prisma.lodgeSettings.create({ data: { id: LODGE_ID, lodgeId: LODGE_ID, capacity: 10 } });
    const rateTypes = await prisma.membershipType.findMany({ select: { id: true } });
    await prisma.season.create({
      data: {
        id: SEASON_ID,
        name: "Race 4189 spring",
        type: "WINTER",
        startDate: new Date("2026-09-01T00:00:00.000Z"),
        endDate: new Date("2026-09-30T00:00:00.000Z"),
        active: true,
        lodgeId: LODGE_ID,
        // One flat rate for every membership type, so the owner's and the
        // non-members' new nights all cost NIGHT_CENTS.
        membershipTypeRates: {
          create: rateTypes.flatMap((type) => [
            { membershipTypeId: type.id, ageTier: "ADULT" as const, pricePerNightCents: NIGHT_CENTS },
            { membershipTypeId: type.id, ageTier: null, pricePerNightCents: NIGHT_CENTS },
          ]),
        },
      },
    });
  }, 120_000);

  beforeEach(async () => {
    await clean();
    await seed();
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.membershipTypeSeasonRate.deleteMany({ where: { seasonId: SEASON_ID } });
    await prisma.season.deleteMany({ where: { id: SEASON_ID } });
    await prisma.lodgeSettings.deleteMany({ where: { id: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.memberAccessRole.deleteMany({ where: { memberId: OFFICER_ID } });
    await prisma.member.deleteMany({ where: { id: { in: [OWNER_ID, OFFICER_ID] } } });
  });

  it("an officer's range-mode edit charges only the added guest, and the gapped guests keep their nights byte for byte", async () => {
    // What the editor sends in range mode: every remaining guest's own dates,
    // and the added guest's bounds.
    const result = await edit(
      { id: OFFICER_ID, role: Role.ADMIN },
      {
        guestStayRanges: [
          { guestId: OWNER_GUEST_ID, ...OWN_DATES },
          { guestId: GAPPED_ID, ...OWN_DATES },
          { guestId: GAPPED_2_ID, ...OWN_DATES },
        ],
        addGuests: [{ firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false, ...OWN_DATES }],
      },
    );
    // Only the friend's three nights. Before #4189 each gapped guest was also
    // put on the 11th, at the season rate: 2 x 5,000 more.
    expect(result.priceDiffCents, "INV-MOD-062: a repeated range charges no gap").toBe(3 * NIGHT_CENTS);
    for (const id of [GAPPED_ID, GAPPED_2_ID]) {
      expect(await nightsOf(id)).toEqual([
        ["2026-09-10", STORED_NIGHT_CENTS, "SOLD"],
        ["2026-09-12", STORED_NIGHT_CENTS, "SOLD"],
      ]);
    }
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID } });
    expect([booking.checkIn, booking.checkOut]).toEqual([CHECK_IN, CHECK_OUT]);
    expect(booking.totalPriceCents).toBe((3 + 2 + 2) * STORED_NIGHT_CENTS + 3 * NIGHT_CENTS);
  }, 60_000);

  it("a member's mixed edit: the repeated gapped guest keeps their nights, the moved one is re-spread", async () => {
    const result = await edit(
      { id: OWNER_ID, role: Role.USER },
      {
        guestStayRanges: [
          { guestId: OWNER_GUEST_ID, ...OWN_DATES },
          // Repeated: the guest's own dates, gap and all.
          { guestId: GAPPED_ID, ...OWN_DATES },
          // Really moved: from the 11th, so the 10th comes off and the 11th goes on.
          { guestId: GAPPED_2_ID, stayStart: "2026-09-11", stayEnd: "2026-09-13" },
        ],
      },
    );
    // The moved guest gains the 11th at the season rate and drops the 10th sold
    // at 4,321. Nothing for the repeated guest.
    expect(result.priceDiffCents).toBe(NIGHT_CENTS - STORED_NIGHT_CENTS);
    expect(await nightsOf(GAPPED_ID)).toEqual([
      ["2026-09-10", STORED_NIGHT_CENTS, "SOLD"],
      ["2026-09-12", STORED_NIGHT_CENTS, "SOLD"],
    ]);
    expect((await nightsOf(GAPPED_2_ID)).map(([night]) => night)).toEqual(["2026-09-11", "2026-09-12"]);
  }, 60_000);
});
