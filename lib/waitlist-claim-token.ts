import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "waitlist-claim-v1";

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required to sign waitlist claim tokens");
  return value;
}

function signingKey(): Buffer {
  return createHmac("sha256", secret()).update("waitlist-claim-token-key-v1").digest();
}

export function signWaitlistClaimToken(entryId: string, expiresAt: Date): string {
  const payload = `${PURPOSE}|${entryId}|${expiresAt.getTime()}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyWaitlistClaimToken(
  token: string,
  expectedEntryId?: string
): { entryId: string; expiresAtMs: number } | null {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const [purpose, entryId, expiryRaw, ...rest] = payload.split("|");
  const expiresAtMs = Number(expiryRaw);
  if (purpose !== PURPOSE || !entryId || rest.length || !Number.isSafeInteger(expiresAtMs)) return null;

  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  if (Date.now() >= expiresAtMs || (expectedEntryId && entryId !== expectedEntryId)) return null;
  return { entryId, expiresAtMs };
}
