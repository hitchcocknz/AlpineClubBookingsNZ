import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";

/**
 * #4288: `fn` in one short transaction of its own that takes the payment's row
 * (`lockPaymentForRefundedTotal`) before anything else - for a writer outside
 * any transaction that must decide and write under that row: the inbound
 * recount's claim. No provider call belongs in `fn`, and it takes no other lock.
 */
export async function withPaymentRowLock<T>(paymentId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockPaymentForRefundedTotal(tx, paymentId);
    return fn(tx);
  });
}
