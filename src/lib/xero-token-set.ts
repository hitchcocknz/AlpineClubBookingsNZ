/**
 * The stored Xero token set's format (#3454), lifted out of
 * `xero-token-store.ts` by #3806 R2 so the token store stays inside its size
 * budget. The value is one encrypted credential-store row (`xero-oauth` /
 * `token-set`); this module only turns it into JSON and back. Never logged,
 * never audited, never echoed in an error.
 */

import { createHash } from "crypto";
import type { CredentialResolution } from "@/lib/integration-credentials";

/** What the store row's encrypted value holds. */
interface StoredXeroTokenSet {
  v: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tenantId: string | null;
  /**
   * The previous release's fingerprint of the `XeroToken` row (#3454): it reads
   * this copy only while the fingerprint matches. Optional on read, so a value
   * written once `XeroToken` is gone (R3) still parses; always written while the
   * previous release can run.
   */
  mirror?: string;
}

/**
 * The previous release's fingerprint of a `XeroToken` row this release created:
 * SHA-256 over `id:accessToken:refreshToken`, the two ciphertext columns being
 * the database's '' default (#3806 R2). Non-secret, and stored only inside the
 * encrypted store value.
 */
export function freshRowMirror(rowId: string): string {
  return createHash("sha256").update(`${rowId}::`, "utf8").digest("hex");
}

export function serializeStoredTokenSet(
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
  tenantId: string | null,
  mirror: string,
): string {
  const value: StoredXeroTokenSet = {
    v: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    tenantId,
    mirror,
  };
  return JSON.stringify(value);
}

/** Parse the store value, or `null` when it is not a token set. */
function parseStoredTokenSet(value: string): StoredXeroTokenSet | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredXeroTokenSet> | null;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      Number.isNaN(Date.parse(parsed.expiresAt)) ||
      (parsed.tenantId !== null && typeof parsed.tenantId !== "string") ||
      (parsed.mirror !== undefined && typeof parsed.mirror !== "string")
    ) {
      return null;
    }
    return parsed as StoredXeroTokenSet;
  } catch {
    // Never echo the value: it holds the tokens.
    return null;
  }
}

/** The usable token set in a store resolution, or `null`. */
export function usableTokenSet(stored: CredentialResolution): StoredXeroTokenSet | null {
  return stored.status === "configured" ? parseStoredTokenSet(stored.value) : null;
}
