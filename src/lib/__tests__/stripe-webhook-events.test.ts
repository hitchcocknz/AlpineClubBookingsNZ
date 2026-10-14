// #4104 review (ops 11): every event the endpoint must be subscribed to has a
// handler in the dispatcher, and DEPLOYMENT.md names the shared list rather
// than a copy of it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { STRIPE_WEBHOOK_EVENT_TYPES } from "@/lib/stripe-webhook-events";

const ROOT = process.cwd();

describe("the Stripe webhook events the endpoint must send (#4104)", () => {
  const service = readFileSync(resolve(ROOT, "src/lib/stripe-webhook-service.ts"), "utf8");

  it("is a list worth guarding", () => {
    expect(STRIPE_WEBHOOK_EVENT_TYPES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(STRIPE_WEBHOOK_EVENT_TYPES).size).toBe(STRIPE_WEBHOOK_EVENT_TYPES.length);
  });

  it.each([...STRIPE_WEBHOOK_EVENT_TYPES])("%s has a case in processStripeWebhookEvent", (eventType) => {
    expect(service, `#4104: "${eventType}" is required of the endpoint but the dispatcher has no case for it`).toContain(`case "${eventType}":`);
  });

  it("DEPLOYMENT.md points at the shared list", () => {
    const deployment = readFileSync(resolve(ROOT, "DEPLOYMENT.md"), "utf8");
    expect(deployment).toContain("src/lib/stripe-webhook-events.ts");
  });
});
