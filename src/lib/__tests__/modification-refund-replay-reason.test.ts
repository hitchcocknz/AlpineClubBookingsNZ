/**
 * #4101 (the #1507 rule, per caller): A BOOKING EDIT'S CARD REFUND AND ITS
 * RECOVERY REPLAY SEND ONE STRIPE REQUEST.
 *
 * `executeBookingModificationRefund` stamps the caller's `metadataReason` on the
 * Stripe refund and, when the refund throws, stores the caller's key prefix on
 * the recovery row. The replay rebuilds the reason from that stored prefix alone
 * (`bookingModificationRefundReasonForKeyPrefix`). Stripe refuses a reused
 * idempotency key whose parameters differ (`idempotency_error`), so a caller
 * whose prefix the map does not know replays a different body and its refund -
 * made on Stripe, lost locally - never recovers. The guest-acceptance re-price
 * was exactly that caller until #4101.
 *
 * The census finds EVERY call in the tree by AST, so a new caller is asked here
 * whether the map knows it. The behavioural half drives the real helper per
 * caller and compares its inline request with the body the replay builds from
 * the prefix it stored; `payment-recovery.test.ts` pins that the replay
 * processor builds exactly that body per prefix.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

const h = vi.hoisted(() => ({
  refundPaymentTransactions: vi.fn(),
  enqueueBookingModificationRefundRecovery: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/payment-transactions", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-transactions")),
  refundPaymentTransactions: h.refundPaymentTransactions,
}));
vi.mock("@/lib/payment-recovery", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/payment-recovery")),
  enqueueBookingModificationRefundRecovery:
    h.enqueueBookingModificationRefundRecovery,
}));

import { executeBookingModificationRefund } from "@/lib/booking-modification-settlement";
import {
  bookingModificationRefundReasonForKeyPrefix,
  buildBookingModificationRefundMetadata,
} from "@/lib/payment-recovery-keys";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const HELPER = "executeBookingModificationRefund";

type Caller = { file: string; keyPrefix: string; metadataReason: string };

/** The literal head of `idempotencyKeyPrefix`: `guest_accept_refund_${id}` -> `guest_accept_refund_`. */
function literalKeyPrefix(node: ts.Expression): string | undefined {
  if (ts.isTemplateExpression(node)) return node.head.text || undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text || undefined;
  }
  return undefined;
}

function scanCallers(): { callers: Caller[]; unreadable: string[] } {
  const callers: Caller[] = [];
  const unreadable: string[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes(HELPER)) continue;
    const source = ts.createSourceFile(
      file,
      code,
      ts.ScriptTarget.Latest,
      false,
      /[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === HELPER
      ) {
        const where = `${relativeSource(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const [arg] = node.arguments;
        const property = (name: string) =>
          arg && ts.isObjectLiteralExpression(arg)
            ? arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) &&
                  ts.isIdentifier(p.name) &&
                  p.name.text === name,
              )?.initializer
            : undefined;
        const reason = property("metadataReason");
        const prefix = property("idempotencyKeyPrefix");
        const keyPrefix = prefix ? literalKeyPrefix(prefix) : undefined;
        if (reason && ts.isStringLiteral(reason) && keyPrefix) {
          callers.push({
            file: relativeSource(file),
            keyPrefix,
            metadataReason: reason.text,
          });
        } else {
          unreadable.push(where);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { callers, unreadable };
}

const { callers: CALLERS, unreadable: UNREADABLE } = scanCallers();

describe("booking-edit card refund: the replay sends the inline request (#4101, #1507)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The inline refund fails after Stripe may have made it (a timeout): the
    // helper stores its key prefix for the replay.
    h.refundPaymentTransactions.mockRejectedValue(new Error("Stripe timed out"));
    h.enqueueBookingModificationRefundRecovery.mockResolvedValue({});
  });

  it("reads every caller's reason and key prefix as literals, so none escapes the check", () => {
    // A caller passing a computed reason or prefix cannot be checked here: spell
    // both as literals at the call site, or extend this census to read the new
    // shape - never exempt it.
    expect(UNREADABLE).toEqual([]);
  });

  it("finds the four booking-edit refund callers", () => {
    expect(
      CALLERS.map(({ file, keyPrefix, metadataReason }) => `${file} ${keyPrefix} ${metadataReason}`).sort(),
    ).toEqual([
      "src/app/api/bookings/[id]/guests/[guestId]/route.ts guest_remove_refund_ guest_removed_price_decrease",
      "src/lib/booking-batch-modification-service.ts mod_batch_refund_ batch_modification",
      "src/lib/booking-date-modification-service.ts mod_dates_refund_ date_change_price_decrease",
      "src/lib/booking-guest-acceptance-reprice.ts guest_accept_refund_ guest_accepted_promo_reprice",
    ]);
  });

  it.each(CALLERS)(
    "$file ($keyPrefix): the replay rebuilds the inline reason from the stored prefix",
    async ({ keyPrefix, metadataReason }) => {
      const bookingId = "booking-1";
      await executeBookingModificationRefund({
        format: CLUB_FORMAT_TEST,
        bookingId,
        result: {
          pendingRefundAmountCents: 4000,
          paymentId: "pay-1",
          bookingModificationId: "mod-1",
          organiserChildRefund: null,
        } as never,
        metadataReason,
        idempotencyKeyPrefix: `${keyPrefix}${bookingId}`,
        failureMessage: "inline refund failed",
        recoveryFailureMessage: "enqueue failed",
      });

      const [inline] = h.refundPaymentTransactions.mock.calls[0];
      const [enqueued] = h.enqueueBookingModificationRefundRecovery.mock.calls[0];
      // The replay sends under the prefix the row stored, so it must be the
      // inline call's own.
      expect(enqueued.stripeKeyPrefix).toBe(inline.idempotencyKeyPrefix);
      // The body the replay builds from that stored prefix alone (the
      // processor's modification branch, pinned per prefix in
      // payment-recovery.test.ts) is the inline body, byte for byte. A failure
      // here means bookingModificationRefundReasonForKeyPrefix lacks this
      // caller's prefix: Stripe would refuse the replay with idempotency_error.
      expect(
        buildBookingModificationRefundMetadata(
          bookingId,
          bookingModificationRefundReasonForKeyPrefix(enqueued.stripeKeyPrefix),
        ),
      ).toEqual(inline.metadata);
      expect(inline.metadata).toEqual({ bookingId, reason: metadataReason });
    },
  );
});
