import { isIP } from "node:net";

/** In-memory sliding-window limits reset on process restart and are per instance. */
const hits = new Map<string, number[]>();

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = hits.get(key) ?? [];
  const recent = timestamps.filter((timestamp) => timestamp > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function normalizeRateLimitEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Check the independent source-IP and normalized-account buckets. */
export function checkRateLimitForIpAndAccount(
  action: string,
  ip: string,
  email: string,
  limit: number,
  windowMs: number,
): boolean {
  const ipAllowed = checkRateLimit(`${action}:ip:${ip}`, limit, windowMs);
  const accountAllowed = checkRateLimitForAccount(action, email, limit, windowMs);
  return ipAllowed && accountAllowed;
}

export function checkRateLimitForAccount(action: string, email: string, limit: number, windowMs: number): boolean {
  const normalizedEmail = normalizeRateLimitEmail(email);
  if (!normalizedEmail) return false;
  return checkRateLimit(`${action}:account:${normalizedEmail}`, limit, windowMs);
}

function trustedProxyHops(): number {
  const parsed = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function maskedIp(ip: string): string {
  if (isIP(ip) === 4) {
    const octets = ip.split(".");
    octets[3] = "0";
    return octets.join(".");
  }
  if (isIP(ip) === 6) {
    const prefix = ip.includes("::") ? ip.split("::")[0] : ip.split(":").slice(0, 4).join(":");
    return prefix ? `${prefix}:…` : "…";
  }
  return "unparseable";
}

/**
 * Selects the client entry before the configured number of trusted rightmost
 * proxy additions. Do not use the leftmost entry: clients can supply it.
 */
export function getClientIp(requestHeaders: Headers): string {
  const forwardedFor = requestHeaders.get("x-forwarded-for") ?? "";
  const forwarded = forwardedFor.split(",").map((entry) => entry.trim()).filter(Boolean);
  const hops = trustedProxyHops();
  const selected = forwarded.length >= hops ? forwarded[forwarded.length - hops] : "";
  const realIp = requestHeaders.get("x-real-ip")?.trim() ?? "";
  const clientIp = selected || realIp || "unknown";

  if (process.env.RATE_LIMIT_DEBUG === "1") {
    console.info(`[rate-limit] xff_entries=${forwarded.length} selected_ip=${maskedIp(clientIp)}`);
  }
  return clientIp;
}

/** Test-only reset guarded by the same env marker as the test database. */
export function __resetRateLimitsForTests(): void {
  if (process.env.NODE_ENV !== "test" && process.env.SCHEDULER_TEST_DB_GUARD !== "1") {
    throw new Error("Rate-limit reset is available only in guarded tests.");
  }
  hits.clear();
}
