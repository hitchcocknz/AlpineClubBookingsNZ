/**
 * THE PREVIOUS RELEASE'S XERO TOKEN STORE (#3454), as the statements it issues
 * against a real PostgreSQL — for `xero-token-credential-store.realdb.test.ts`,
 * which proves #3806 R2 against it.
 *
 * R2 runs beside the #3454 code during a blue-green deploy and is replaced by it
 * after a rollback. That code reads, refreshes, connects and disconnects only
 * through `XeroToken` and the credential-store row; it knows nothing of
 * `XeroConnection`. Its algorithm, restated here from the deployed
 * `src/lib/xero-token-store.ts` at #3454 (merge of PR #3805):
 *
 *   - READ: the store row first, then the most recently written `XeroToken`
 *     row. No row: not connected. The store copy is read when its `mirror`
 *     equals SHA-256(`${id}:${accessToken}:${refreshToken}`) of that row;
 *     otherwise the row's own ciphertext is decrypted under the wrapped key.
 *   - CLAIM: `UPDATE "XeroToken" SET "refreshInProgressUntil" = lease WHERE id =
 *     <latest> AND (lease IS NULL OR lease <= now)`.
 *   - CONNECT / REFRESH SAVE: one transaction writing the row's ciphertext (a
 *     fresh IV each time) and the store copy with the matching `mirror`.
 *   - DISCONNECT: delete every `XeroToken` row and the store row.
 *
 * The R2 schema `@ignore`s the two ciphertext columns, so the generated client
 * cannot name them; that is why every statement touching them here is raw SQL,
 * exactly the SQL the #3454 client emitted. The store row goes through the real
 * credential store, which #3454 also used and R2 did not change; its writes run
 * on the application client, through `withCredentialTransaction`, as #3454's did. The wrapped
 * token key is a fixed test key: R2 never reads it, so only this emulation needs
 * it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import type { CredentialActor } from "@/lib/integration-credential-actor";
import {
  deleteIntegrationCredentialInTransaction,
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  withCredentialTransaction,
} from "@/lib/integration-credentials";
import {
  XERO_OAUTH_TOKEN_KEY,
  XERO_OAUTH_TOKEN_PROVIDER,
  type TokenData,
} from "@/lib/xero-token-store";

const KEY = Buffer.from("7".repeat(64), "hex");

function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

function decrypt(value: string): string {
  const [iv, tag, body] = value.split(":");
  if (!iv || !tag || body === undefined) throw new Error("3454: XeroTokenDecryptError");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(body, "hex", "utf8") + decipher.final("utf8");
}

/** #3454's `mirrorFingerprint`, byte for byte. */
export function fingerprint3454(row: {
  id: string;
  accessToken: string;
  refreshToken: string;
}): string {
  return createHash("sha256")
    .update(`${row.id}:${row.accessToken}:${row.refreshToken}`, "utf8")
    .digest("hex");
}

interface Row3454 {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
}

type Client = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "integrationCredential">;

async function latestRow(db: Client): Promise<Row3454 | null> {
  const rows = await db.$queryRaw<Row3454[]>`
    SELECT "id", "accessToken", "refreshToken", "expiresAt", "tenantId", "refreshInProgressUntil"
      FROM "XeroToken"
     ORDER BY "updatedAt" DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

export interface Read3454 {
  /** Which copy the #3454 code would hand its caller. */
  source: "store" | "row";
  rowId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
}

/** #3454's `readCurrentTokens`: what the previous release would use now. */
export async function read3454(db: Client): Promise<Read3454 | null> {
  const stored = await readIntegrationCredentialRow(
    db,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  const row = await latestRow(db);
  if (!row) return null;
  if (stored.status === "configured") {
    const value = JSON.parse(stored.value) as {
      v: number;
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      tenantId: string | null;
      mirror?: unknown;
    };
    // #3454's parser required a string `mirror`; anything else is "not a set".
    if (value.v === 1 && typeof value.mirror === "string" && value.mirror === fingerprint3454(row)) {
      return {
        source: "store",
        rowId: row.id,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: new Date(value.expiresAt),
        tenantId: value.tenantId,
      };
    }
  }
  return {
    source: "row",
    rowId: row.id,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.expiresAt,
    tenantId: row.tenantId,
  };
}

/** #3454's claim statement. Returns whether it took the lease. */
export async function claim3454(
  db: Client,
  now: Date,
  leaseUntil: Date,
): Promise<boolean> {
  const count = await db.$executeRaw`
    UPDATE "XeroToken"
       SET "refreshInProgressUntil" = ${leaseUntil}, "updatedAt" = ${now}
     WHERE "id" = (SELECT "id" FROM "XeroToken" ORDER BY "updatedAt" DESC LIMIT 1)
       AND ("refreshInProgressUntil" IS NULL OR "refreshInProgressUntil" <= ${now})`;
  return Number(count) === 1;
}

/**
 * #3454's refresh save: both copies under its lease, the store copy with a
 * fresh mirror. Throws when the lease no longer matches, as #3454 did.
 */
export async function save3454(
  tokens: TokenData,
  leaseUntil: Date,
  actor: CredentialActor,
): Promise<void> {
  const access = encrypt(tokens.accessToken);
  const refresh = encrypt(tokens.refreshToken);
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const row = await latestRow(tx);
    if (!row) throw new Error("3454: not connected");
    const updated = await tx.$executeRaw`
      UPDATE "XeroToken"
         SET "accessToken" = ${access}, "refreshToken" = ${refresh},
             "expiresAt" = ${tokens.expiresAt}, "tenantId" = ${tokens.tenantId ?? null},
             "refreshInProgressUntil" = NULL, "updatedAt" = ${new Date()}
       WHERE "id" = ${row.id} AND "refreshInProgressUntil" <= ${leaseUntil}`;
    if (Number(updated) !== 1) {
      throw new Error("3454: Xero token refresh lease expired before refreshed tokens could be saved");
    }
    await setIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      value: JSON.stringify({
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        tenantId: tokens.tenantId ?? null,
        mirror: fingerprint3454({ id: row.id, accessToken: access, refreshToken: refresh }),
      }),
      actor,
      expect: { expect: "any" },
      cause: { kind: "token-refresh" },
    });
  });
}

/** #3454's connect: update the latest row in place, or create one. */
export async function connect3454(
  tokens: TokenData,
  actor: CredentialActor,
): Promise<void> {
  const access = encrypt(tokens.accessToken);
  const refresh = encrypt(tokens.refreshToken);
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const existing = await latestRow(tx);
    const id = existing?.id ?? `xt3454-${randomBytes(6).toString("hex")}`;
    const now = new Date();
    if (existing) {
      await tx.$executeRaw`
        UPDATE "XeroToken"
           SET "accessToken" = ${access}, "refreshToken" = ${refresh},
               "expiresAt" = ${tokens.expiresAt}, "tenantId" = ${tokens.tenantId ?? null},
               "refreshInProgressUntil" = NULL, "updatedAt" = ${now}
         WHERE "id" = ${id}`;
    } else {
      await tx.$executeRaw`
        INSERT INTO "XeroToken"
          ("id", "accessToken", "refreshToken", "expiresAt", "tenantId", "createdAt", "updatedAt")
        VALUES (${id}, ${access}, ${refresh}, ${tokens.expiresAt}, ${tokens.tenantId ?? null}, ${now}, ${now})`;
    }
    await setIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      value: JSON.stringify({
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        tenantId: tokens.tenantId ?? null,
        mirror: fingerprint3454({ id, accessToken: access, refreshToken: refresh }),
      }),
      actor,
      expect: { expect: "any" },
      cause: { kind: "oauth-connect" },
    });
  });
}

/** #3454's disconnect: every `XeroToken` row and the store row. */
export async function disconnect3454(
  actor: CredentialActor,
): Promise<void> {
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    await tx.$executeRaw`DELETE FROM "XeroToken"`;
    await deleteIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      actor,
      expect: { expect: "any" },
      cause: { kind: "oauth-disconnect" },
    });
  });
}
