import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { cardRefundDoorOf } from "@/lib/card-refund-own-note-share";
import * as keys from "@/lib/payment-recovery-keys";

/**
 * #4312 review (`INV-ADDPAY-044`, `INV-SSOT`): EVERY STRIPE REFUND THE APP
 * MAKES STAMPS A `reason` IN ITS METADATA.
 *
 * The `charge.refunded` webhook gives a card refund on a bank transfer a Xero
 * note of its own only when the refund carries no app `reason`
 * (`cardRefundDoorOf` reads it as made in the Stripe dashboard). A door that
 * refunded with no `reason` would be taken for the dashboard: its refund noted
 * by the webhook AND by the door's own note - one refund credited twice. So:
 *
 * - every call that makes a Stripe refund (`processRefund`,
 *   `refundPaymentTransactions`) outside tests passes `metadata`, and an object
 *   literal passed there names a `reason`;
 * - every metadata builder in `payment-recovery-keys.ts` stamps a non-empty one,
 *   so a door passing a builder's answer is read as an app door.
 *
 * A source scan: `pnpm run test:related` cannot select it, so it runs by name.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const REFUND_CALL = /\b(processRefund|refundPaymentTransactions)\(/g;

/** The argument text of a call whose open paren is at `open`, by bracket depth. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
}

/** Each refund call site that does not pass a `metadata` naming a reason: `path:line`. */
function refundCallsWithoutReason(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const findings: string[] = [];
  for (const { path, text } of files) {
    for (const match of text.matchAll(REFUND_CALL)) {
      const index = match.index ?? 0;
      const lineStart = text.lastIndexOf("\n", index) + 1;
      const line = text.slice(lineStart, text.indexOf("\n", index) === -1 ? undefined : text.indexOf("\n", index)).trim();
      // A declaration, a comment, or an import names the function without calling it.
      if (/^(\*|\/\/|export (async )?function|(async )?function)/.test(line) || /function\s+(processRefund|refundPaymentTransactions)\(/.test(line)) continue;
      const args = callArguments(text, index + match[0].length - 1);
      const metadata = /\bmetadata\b\s*(:\s*)?([^,\n}]*)/.exec(args);
      const literal = metadata?.[1] && metadata[2]?.trim().startsWith("{") ? args.slice(args.indexOf("metadata")) : null;
      if (!metadata || (literal !== null && !/\breason\b/.test(literal.slice(0, literal.indexOf("}") + 1)))) {
        findings.push(`${path}:${text.slice(0, index).split("\n").length}`);
      }
    }
  }
  return findings;
}

function sourceFiles(): Array<{ path: string; text: string }> {
  const root = join(REPO_ROOT, "src");
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/(^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => ({ path: relative(REPO_ROOT, join(root, file)), text: readFileSync(join(root, file), "utf8") }));
}

describe("every Stripe refund the app makes stamps a reason (#4312 review)", () => {
  it("every refund call outside tests passes metadata, and a literal one names a reason", () => {
    const files = sourceFiles();
    const calls = files.flatMap((file) => [...file.text.matchAll(REFUND_CALL)]);
    expect(calls.length).toBeGreaterThan(10);
    expect(refundCallsWithoutReason(files)).toEqual([]);
  });

  it("FAILS on a refund call with no metadata, or a literal one with no reason (fixture proof)", () => {
    expect(refundCallsWithoutReason([{ path: "a.ts", text: "await processRefund({ paymentIntentId, amountCents });" }])).toEqual(["a.ts:1"]);
    expect(refundCallsWithoutReason([{ path: "b.ts", text: "\nawait refundPaymentTransactions({ paymentId, metadata: { bookingId }, format });" }])).toEqual(["b.ts:2"]);
    expect(refundCallsWithoutReason([{ path: "c.ts", text: "await stripe.processRefund({ metadata: { bookingId, reason: \"x\" } });" }])).toEqual([]);
    expect(refundCallsWithoutReason([{ path: "d.ts", text: "await deps.refundPaymentTransactions({ metadata, format });" }])).toEqual([]);
  });

  it("every metadata builder stamps a reason, so its refunds read as an app door's", () => {
    const builders = Object.entries(keys).filter(([name, value]) => /^build\w*RefundMetadata$/.test(name) && typeof value === "function");
    expect(builders.map(([name]) => name).sort()).toEqual([
      "buildBookingCancellationRefundMetadata",
      "buildBookingModificationRefundMetadata",
      "buildLateCaptureRefundMetadata",
      "buildRefundRequestRefundMetadata",
    ]);
    for (const [name, build] of builders) {
      const metadata = (build as (...args: string[]) => Record<string, string>)("booking-1", "reason-or-request");
      expect(metadata.reason, name).toEqual(expect.stringMatching(/\S/));
      expect(cardRefundDoorOf(metadata), name).not.toBe("outside-app");
    }
    for (const type of ["REFUND_SUPERSEDED_PAYMENT", "REFUND_BOOKING_MODIFICATION"]) {
      for (const idempotencyKey of ["refund_request_refund_rr-1", "booking_cancel_refund_recovery_b-1", "mod-refund-x"]) {
        const metadata = keys.cardRefundOperationRefundMetadata({ type, idempotencyKey, stripeKeyPrefix: null, bookingId: "booking-1" });
        expect(cardRefundDoorOf(metadata)).not.toBe("outside-app");
      }
    }
  });
});
