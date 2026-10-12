import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #4036: `mintOrdinaryAskIntent` sends the one planned request; a recovery's
  replay that Stripe refuses (`idempotency_error`) adopts the intent the key
  already minted, only when exactly one unrecorded intent matches, and
  otherwise throws the refusal as it came. The door's own first mint never
  looks anything up.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  listRecentPaymentIntentsMatching: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  listRecentPaymentIntentsMatching: mocks.listRecentPaymentIntentsMatching,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { paymentTransaction: { findMany: mocks.paymentTransactionFindMany } },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mintOrdinaryAskIntent } from "@/lib/ordinary-ask-mint";
import { ordinaryAskDoorRequest, planOrdinaryAskMint } from "@/lib/ordinary-ask-request";
import { MINTED_INTENT_LOOKBACK_MS } from "@/lib/reissued-ask-mint";
import { stripeChargeCurrency } from "@/lib/stripe-charge-currency";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { stripeSdkError } from "./support/stripe-sdk-error";

const BOOKING = "bk_4036";
const door = ordinaryAskDoorRequest("guestAdd", BOOKING, "mod_4036");
const plan = planOrdinaryAskMint({
  bookingId: BOOKING,
  bookingModificationId: "mod_4036",
  stripeKey: door.idempotencyKey,
  frozenAmountCents: 6_000,
  amountCents: 6_000,
});
const RECOVERY = { createdAt: new Date("2026-06-30T00:00:00.000Z") };
const CURRENCY = stripeChargeCurrency(CLUB_FORMAT_TEST);

function intent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    amount: 6_000,
    currency: CURRENCY,
    customer: "cus_door",
    status: "requires_payment_method",
    metadata: { bookingId: BOOKING, type: "modification_additional", reason: door.reason },
    ...overrides,
  };
}

/** Stripe's list, as the real helper reads it: every intent `matches` accepts. */
function stripeHolds(...intents: ReturnType<typeof intent>[]) {
  mocks.listRecentPaymentIntentsMatching.mockImplementation(
    async ({ matches }: { matches: (pi: unknown) => boolean }) => intents.filter((pi) => matches(pi)),
  );
}

const refusal = () =>
  stripeSdkError({ type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
});

describe("mintOrdinaryAskIntent (#4036)", () => {
  it("sends the planned request byte for byte", async () => {
    mocks.createPaymentIntent.mockResolvedValue({ id: "pi_new" });

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).resolves.toEqual({ id: "pi_new" });
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      amountCents: 6_000,
      customerId: "cus_door",
      metadata: { bookingId: BOOKING, type: "modification_additional", reason: "guest_add_price_increase" },
      idempotencyKey: door.idempotencyKey,
    });
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("the door's own refusal is thrown without a lookup: nothing can have minted before it", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_door"));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: null }),
    ).rejects.toBe(err);
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("any other failure is thrown as it came, without a lookup", async () => {
    const err = stripeSdkError({ type: "api_error" });
    mocks.createPaymentIntent.mockRejectedValue(err);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("a refused replay adopts the one unrecorded intent the key minted, looked for from just before the recovery was written", async () => {
    mocks.createPaymentIntent.mockRejectedValue(refusal());
    stripeHolds(intent("pi_other_booking", { metadata: { ...intent("x").metadata, bookingId: "bk_other" } }), intent("pi_door"));

    const adopted = await mintOrdinaryAskIntent({
      format: CLUB_FORMAT_TEST,
      plan,
      customerId: "cus_moved",
      recovery: RECOVERY,
    });

    expect(adopted.id).toBe("pi_door");
    expect(mocks.listRecentPaymentIntentsMatching).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_moved",
        createdSince: new Date(RECOVERY.createdAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
      }),
    );
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: { in: ["pi_door"] } },
      select: { stripePaymentIntentId: true },
    });
  });

  it("never adopts an intent already on the ledger - it is another ask's", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_recorded"));
    mocks.paymentTransactionFindMany.mockResolvedValue([{ stripePaymentIntentId: "pi_recorded" }]);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
  });

  it("fails closed when more than one unrecorded intent matches, rather than guess", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_one"), intent("pi_two"));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
  });

  it("fails closed when nothing matches - a cancelled or differently-sized intent is not this ask", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_cancelled", { status: "canceled" }), intent("pi_smaller", { amount: 5_000 }));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });
});
