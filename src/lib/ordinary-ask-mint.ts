/**
 * #4036: MINT AN ORDINARY EDIT'S PRICE ASK FROM ITS ONE PLANNED REQUEST
 * (`planOrdinaryAskMint`), for the edit's door and the recovery runner alike.
 *
 * The runner's replay is normally answered by Stripe with the intent the door's
 * lost reply minted. A refusal (`idempotency_error`) still comes back when the
 * earlier request differed after all: the stored customer changed between the
 * two, the club's charge currency changed, or the earlier request came from a
 * release that sent other parameters. Stripe cannot look an intent up by its
 * key, and the door's intent carries no key in its metadata (stamping one would
 * make every row the previous release wrote differ again), so the runner finds
 * it by what it asks for: the one recent intent that is this booking's ask, by
 * this door's reason, for this amount in this currency, unpaid, and on no
 * ledger row (`isIntentForOrdinaryAskPlan`). None, or more than one, and the
 * refusal is thrown as it was: the recovery backs off and retries, and on
 * exhaustion alerts an officer. It never guesses which of two intents is owed.
 */
import type Stripe from "stripe";

import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { isIntentForOrdinaryAskPlan, type OrdinaryAskMintPlan } from "@/lib/ordinary-ask-request";
import { prisma } from "@/lib/prisma";
import { MINTED_INTENT_LOOKBACK_MS } from "@/lib/reissued-ask-mint";
import { createPaymentIntent, listRecentPaymentIntentsMatching } from "@/lib/stripe";
import { stripeChargeCurrency } from "@/lib/stripe-charge-currency";
import { stripeErrorApiType } from "@/lib/stripe-errors";

export async function mintOrdinaryAskIntent({
  format,
  plan,
  customerId,
  recovery,
}: {
  format: ClubFormat;
  plan: OrdinaryAskMintPlan;
  customerId: string | undefined;
  /**
   * The recovery row this mint replays, or null for the door's own first mint,
   * which no earlier request can have preceded: its refusal is thrown, and the
   * door keeps the debt on a recovery row as it does for any failure.
   */
  recovery: { createdAt: Date } | null;
}): Promise<Stripe.PaymentIntent> {
  try {
    return await createPaymentIntent({
      format,
      amountCents: plan.amountCents,
      customerId,
      metadata: { ...plan.metadata },
      idempotencyKey: plan.idempotencyKey,
    });
  } catch (err) {
    if (!recovery || stripeErrorApiType(err) !== "idempotency_error") throw err;
    const minted = await findIntentMintedForOrdinaryAsk({
      format,
      plan,
      customerId,
      createdSince: new Date(recovery.createdAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
    });
    if (!minted) throw err;
    logger.warn(
      { paymentIntentId: minted.id, idempotencyKey: plan.idempotencyKey, bookingId: plan.bookingId },
      "An ordinary additional ask's key had already minted an intent under other parameters; using that intent (#4036)",
    );
    return minted;
  }
}

async function findIntentMintedForOrdinaryAsk({
  format,
  plan,
  customerId,
  createdSince,
}: {
  format: ClubFormat;
  plan: OrdinaryAskMintPlan;
  customerId: string | undefined;
  createdSince: Date;
}): Promise<Stripe.PaymentIntent | null> {
  const currency = stripeChargeCurrency(format);
  const candidates = await listRecentPaymentIntentsMatching({
    matches: (intent) => isIntentForOrdinaryAskPlan(intent, plan, currency),
    createdSince,
    customerId,
  });
  if (candidates.length === 0) return null;
  // An intent already on the ledger is some other ask's, never this one: the
  // replay runs only because this ask's mint wrote no row.
  const recorded = await prisma.paymentTransaction.findMany({
    where: { stripePaymentIntentId: { in: candidates.map((intent) => intent.id) } },
    select: { stripePaymentIntentId: true },
  });
  const recordedIds = new Set(recorded.map((row) => row.stripePaymentIntentId));
  const unrecorded = candidates.filter((intent) => !recordedIds.has(intent.id));
  if (unrecorded.length === 1) return unrecorded[0]!;
  logger.error(
    {
      bookingId: plan.bookingId,
      idempotencyKey: plan.idempotencyKey,
      candidateIntentIds: unrecorded.map((intent) => intent.id),
    },
    unrecorded.length === 0
      ? "An ordinary additional ask's key was refused and every matching intent is already another ask's; failing closed (#4036)"
      : "An ordinary additional ask's key was refused and more than one unrecorded intent matches it; failing closed rather than guess (#4036)",
  );
  return null;
}
