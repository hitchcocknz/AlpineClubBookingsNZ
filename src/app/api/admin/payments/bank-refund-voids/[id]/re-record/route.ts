import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { nonNegativeCentsSchema } from "@/lib/edit-financial-review-context";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import {
  BankRefundVoidResolutionError,
  reRecordBankTransferRefund,
} from "@/lib/bank-refund-void-resolution";

/**
 * Explicit confirmation, so recording a refund again is never a single-click
 * accident; the voided note's amount the dialog showed, read-only (owner, 17
 * Oct 2026, Q1: a moved figure is a 409); and the treasurer's reason.
 */
const bodySchema = z
  .object({
    expectedAmountCents: nonNegativeCentsSchema,
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX),
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/payments/bank-refund-voids/[id]/re-record
 *
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): record a
 * bank-transfer refund again after Xero voided its credit note. `[id]` is the
 * voided note's link. Gated `finance:edit`, the permission that completes a
 * refund paid back by hand. Puts the refunded total back and queues one fresh
 * refund note keyed on the record; no booking event and no member email (Q3).
 * The rules are `reRecordBankTransferRefund`'s.
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
    const result = await reRecordBankTransferRefund({
      linkId: id,
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
    logger.error({ err: error, linkId: id }, "Recording a voided bank-transfer refund again failed");
    return NextResponse.json(
      { error: "Could not record the refund again." },
      { status: 500 },
    );
  }
}
