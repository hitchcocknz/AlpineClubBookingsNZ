/**
 * #4199: the doors that take a party or an edit's guest lists — create, quote,
 * the promo preview, modify and the modify quote — read a guest's `nights`
 * through the one request shape (`guestNightListSchema`) and refuse a guest list
 * longer than `BOOKING_REQUEST_GUESTS_MAX`, before anything reads the database.
 * (The exception-request door's cases live in its own route suite.)
 *
 * The quote route used to accept any string as a night (`z.array(z.string())`),
 * so a night that is not a date reached the pricing pass; and the quote and the
 * promo preview took a guest list of any length into their per-guest loops.
 *
 * Every request here is refused at the schema, so the database is a stub that
 * throws if anything reaches it. Frozen clock discipline: fixed August 2026
 * lodge nights, after the 2026-07-01 freeze.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BOOKING_REQUEST_GUESTS_MAX } from "@/lib/booking-guest-stay-range-input";

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error("the database was reached; the schema should have refused this request");
      },
    },
  ),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } })),
}));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  rateLimiters: { bookingCreate: {}, bookingQuery: {} },
}));

import { POST as createPOST } from "@/app/api/bookings/route";
import { POST as quotePOST } from "@/app/api/bookings/quote/route";
import { POST as validatePOST } from "@/app/api/promo-codes/validate/route";
import { PUT as modifyPUT } from "@/app/api/bookings/[id]/modify/route";
import { modifyQuoteSchema } from "@/lib/booking-modify-quote-request";

const doors = [
  { name: "create", post: createPOST, url: "http://localhost/api/bookings", extra: {} },
  { name: "quote", post: quotePOST, url: "http://localhost/api/bookings/quote", extra: {} },
  { name: "promo preview", post: validatePOST, url: "http://localhost/api/promo-codes/validate", extra: { code: "SAVE" } },
] as const;

const guest = { firstName: "Sam", lastName: "Guest", ageTier: "ADULT", isMember: false };

async function send(door: (typeof doors)[number], guests: unknown[]) {
  const res = await door.post(
    new NextRequest(door.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkIn: "2026-08-10", checkOut: "2026-08-13", guests, ...door.extra }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe.each(doors)("$name refuses a malformed guest list at the schema (#4199)", (door) => {
  it("refuses a night that is not a date", async () => {
    const { status, body } = await send(door, [{ ...guest, nights: ["2026-08-10", "2026-13-45"] }]);
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid input");
  });

  it(`refuses more than ${BOOKING_REQUEST_GUESTS_MAX} guests`, async () => {
    const { status, body } = await send(door, Array.from({ length: BOOKING_REQUEST_GUESTS_MAX + 1 }, () => guest));
    expect(status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(JSON.stringify(body.details.fieldErrors.guests)).toContain(String(BOOKING_REQUEST_GUESTS_MAX));
  });
});

/** An edit's guest lists: what the modify route and its quote both take. */
const tooMany = <T,>(make: (index: number) => T) =>
  Array.from({ length: BOOKING_REQUEST_GUESTS_MAX + 1 }, (_, index) => make(index));
const editCases: Array<[string, Record<string, unknown>]> = [
  ["a night that is not a date", { guestStayRanges: [{ guestId: "g1", nights: ["2026-08-10", "2026-13-45"] }] }],
  ["an added guest's night that is not a date", { addGuests: [{ ...guest, nights: ["not-a-night"] }] }],
  ["too many added guests", { addGuests: tooMany(() => guest) }],
  ["too many removed guests", { removeGuestIds: tooMany((index) => `g${index}`) }],
  ["too many stay ranges", { guestStayRanges: tooMany((index) => ({ guestId: `g${index}`, nights: ["2026-08-10"] })) }],
];

describe.each(editCases)("an edit refuses %s at the schema (#4199)", (_label, body) => {
  it("the modify route", async () => {
    const res = await modifyPUT(
      new NextRequest("http://localhost/api/bookings/booking-1/modify", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "booking-1" }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("the modify quote", () => {
    expect(modifyQuoteSchema.safeParse(body).success).toBe(false);
  });
});

describe("an edit at the bound is accepted by the schema", () => {
  it("takes exactly the maximum", () => {
    const atBound = { removeGuestIds: Array.from({ length: BOOKING_REQUEST_GUESTS_MAX }, (_, index) => `g${index}`) };
    expect(modifyQuoteSchema.safeParse(atBound).success).toBe(true);
  });
});

describe("the bound is the shared one", () => {
  it("is the 200 the create route always had", () => {
    expect(BOOKING_REQUEST_GUESTS_MAX).toBe(200);
  });
});
