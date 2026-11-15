import { timingSafeEqual } from "node:crypto";

export function isValidCronAuthorization(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret || !authHeader?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authHeader.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
