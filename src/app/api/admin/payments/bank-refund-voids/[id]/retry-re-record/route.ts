import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import {
  BankRefundVoidResolutionError,
  retryBankTransferRefundReRecord,
} from "@/lib/bank-refund-void-resolution";

/** Explicit confirmation, and an optional note for the audit row. */
const bodySchema = z
  .object({
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional(),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/retry-re-record
 *
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): queue a recorded-again
 * bank-transfer refund's credit note again, after it failed or landed short.
 * `[id]` is the voided note's link. Gated `finance:edit`. The same record, so
 * the same Xero key: it can never raise a second note. The rules are
 * `retryBankTransferRefundReRecord`'s.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await retryBankTransferRefundReRecord({
      linkId: id,
      note: parsed.data.note,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/stuck-states");
    revalidatePath("/admin/payments");
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof BankRefundVoidResolutionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, linkId: id }, "Retrying a recorded-again bank-transfer refund's note failed");
    return NextResponse.json(
      { error: "Could not retry the credit note." },
      { status: 500 },
    );
  }
}
