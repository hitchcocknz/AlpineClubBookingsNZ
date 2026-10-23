/**
 * ONE `@/lib/auth` double for the #1881 real-PostgreSQL harness (#4312), as
 * `stripe-race-double.ts` is for Stripe. A `vi.mock` in a file the harness
 * imports is registered for the whole harness process, and the LAST file to
 * register a factory for a module wins, so every realdb file that needs a
 * signed-in session registers this same factory and sets the one shared
 * holder - signed out (`null`) unless a case installs a session, and put back
 * to `null` by that case.
 */
export const authRaceSession: { current: null | { user: Record<string, unknown> } } = { current: null };

export function authRaceDouble() {
  return { auth: () => Promise.resolve(authRaceSession.current) };
}
