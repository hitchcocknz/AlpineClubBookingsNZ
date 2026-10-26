import type { Prisma } from "@prisma/client";

import { sizeAdditionalAsk, type AdditionalAsk } from "@/lib/additional-payment-ask";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

/**
 * #4442: called BEFORE writing the new ask, after global then Payment-row locks.
 * A capture in the sizing-to-queue window changes the mirrored unpaid balance.
 * Refuse the entire queue transaction: the minted secret was never offered and
 * the durable recovery will re-plan through the same sizing helper. Folded
 * waiting re-issues are separate from this live balance and remain owed.
 */
export async function assertAdditionalAskSizingCurrent(
  store: Prisma.TransactionClient,
  paymentId: string,
  ask: AdditionalAsk,
): Promise<void> {
  if (ask.paymentBalanceCents === null) return;
  const payment = await store.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: { additionalAmountCents: true, additionalPaymentStatus: true },
  });
  const current = sizeAdditionalAsk({ priceDiffCents: 0, changeFeeCents: 0, payment });
  if (current.carriedCents !== ask.paymentBalanceCents) {
    throw new Error("The carried additional ask changed while its replacement was being minted; retry and re-plan");
  }
}

/** The inline minters' queue boundary; no provider call belongs in write. */
export async function withAdditionalAskQueueTransaction<T>(
  paymentId: string,
  ask: AdditionalAsk,
  write: (store: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (store) => {
    // INV-LOCK-001/002: capture and settlement money, global before row locks.
    await store.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await lockPaymentForRefundedTotal(store, paymentId);
    await assertAdditionalAskSizingCurrent(store, paymentId, ask);
    return write(store);
  });
}
