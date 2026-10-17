import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { BANK_REFUND_VOID_CONFIRM_REASONS } from "@/lib/bank-refund-void-copy";
import {
  BankRefundVoidResolutionError,
  confirmBankTransferRefundCancelled,
} from "@/lib/bank-refund-void-resolution";

/**
 * Explicit confirmation; the treasurer's own answer to "cancelled, or replaced
 * by hand in Xero?" (never inferred); the voided note's amount the dialog
 * showed (a moved figure is a 409); and the reason.
 */
const bodySchema = z
  .object({
    reason: z.enum(BANK_REFUND_VOID_CONFIRM_REASONS),
    expectedAmountCents: nonNegativeCentsSchema,
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/confirm-cancelled
 *
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): clear a
 * voided bank-transfer refund note from the list. `[id]` is the voided note's
 * link. Gated `finance:edit`. The reason is required and recorded as the
 * outcome (owner, 17 Oct 2026): "cancelled" takes the refund back out of the
 * payment's records and reverses its ledger line; "replaced-in-xero" moves
 * nothing. No Xero call and no member email. The rules are
 * `confirmBankTransferRefundCancelled`'s.
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
    const result = await confirmBankTransferRefundCancelled({
      linkId: id,
      reason: parsed.data.reason,
      expectedAmountCents: parsed.data.expectedAmountCents,
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
    logger.error({ err: error, linkId: id }, "Confirming a voided bank-transfer refund failed");
    return NextResponse.json(
      { error: "Could not confirm the refund." },
      { status: 500 },
    );
  }
}
