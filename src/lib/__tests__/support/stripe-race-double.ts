/**
 * ONE pass-through `@/lib/stripe` double for the #1881 real-PostgreSQL harness.
 *
 * A `vi.mock` in a file the harness imports is registered for the whole
 * harness process, and the LAST file to register a factory for a module wins.
 * So every realdb file that doubles a Stripe call registers this same factory
 * (`stripeRaceDouble`) and installs its hooks on this one shared object: the
 * double behaves the same whichever file registered last, and every call no
 * case has hooked runs the REAL function.
 */
import type * as StripeModule from "@/lib/stripe";

type Stripe = typeof StripeModule;

export const stripeRaceHooks: {
  update: null | ((id: string, amountCents: number) => Promise<unknown>);
  get: null | ((id: string) => Promise<unknown>);
  create: null | ((args: Parameters<Stripe["createPaymentIntent"]>[0]) => Promise<unknown>);
  findByMetadata: null | ((args: Parameters<Stripe["findRecentPaymentIntentByMetadata"]>[0]) => Promise<unknown>);
  cancel: null | ((id: string) => Promise<unknown>);
} = { update: null, get: null, create: null, findByMetadata: null, cancel: null };

export function resetStripeRaceHooks(): void {
  stripeRaceHooks.update = null;
  stripeRaceHooks.get = null;
  stripeRaceHooks.create = null;
  stripeRaceHooks.findByMetadata = null;
  stripeRaceHooks.cancel = null;
}

export function stripeRaceDouble(actual: Stripe): Stripe {
  return {
    ...actual,
    updatePaymentIntentAmount: ((id: string, amountCents: number) =>
      stripeRaceHooks.update
        ? stripeRaceHooks.update(id, amountCents)
        : actual.updatePaymentIntentAmount(id, amountCents)) as Stripe["updatePaymentIntentAmount"],
    getPaymentIntent: ((...args: Parameters<Stripe["getPaymentIntent"]>) =>
      stripeRaceHooks.get ? stripeRaceHooks.get(args[0]) : actual.getPaymentIntent(...args)) as Stripe["getPaymentIntent"],
    createPaymentIntent: ((args: Parameters<Stripe["createPaymentIntent"]>[0]) =>
      stripeRaceHooks.create ? stripeRaceHooks.create(args) : actual.createPaymentIntent(args)) as Stripe["createPaymentIntent"],
    findRecentPaymentIntentByMetadata: ((args: Parameters<Stripe["findRecentPaymentIntentByMetadata"]>[0]) =>
      stripeRaceHooks.findByMetadata
        ? stripeRaceHooks.findByMetadata(args)
        : actual.findRecentPaymentIntentByMetadata(args)) as Stripe["findRecentPaymentIntentByMetadata"],
    cancelPaymentIntentIfCancellableWithResult: ((...args: Parameters<Stripe["cancelPaymentIntentIfCancellableWithResult"]>) =>
      stripeRaceHooks.cancel
        ? stripeRaceHooks.cancel(args[0])
        : actual.cancelPaymentIntentIfCancellableWithResult(...args)) as Stripe["cancelPaymentIntentIfCancellableWithResult"],
  };
}
