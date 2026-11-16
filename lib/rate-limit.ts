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

function isDecimal(value: string): boolean {
  if (!value) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function validPort(value: string): boolean {
  if (!isDecimal(value) || value.length > 5) return false;
  const port = Number(value);
  return port >= 0 && port <= 65535;
}

function isIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!isDecimal(octet) || octet.length > 3 || (octet.length > 1 && octet[0] === "0")) return false;
    if (Number(octet) > 255) return false;
  }
  return true;
}

function isHexGroup(value: string): boolean {
  if (value.length < 1 || value.length > 4) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70))) return false;
  }
  return true;
}

function isIpv6(value: string): boolean {
  if (!value || value.length > 45) return false;
  const compressionAt = value.indexOf("::");
  if (compressionAt >= 0 && value.indexOf("::", compressionAt + 2) >= 0) return false;

  const leftText = compressionAt < 0 ? value : value.slice(0, compressionAt);
  const rightText = compressionAt < 0 ? "" : value.slice(compressionAt + 2);
  const groups = (leftText ? leftText.split(":") : []).concat(rightText ? rightText.split(":") : []);
  let groupCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.includes(".")) {
      if (i !== groups.length - 1 || !isIpv4(group)) return false;
      groupCount += 2;
    } else {
      if (!isHexGroup(group)) return false;
      groupCount++;
    }
  }
  return compressionAt >= 0 ? groupCount < 8 : groupCount === 8;
}

function parseIpForMask(input: string): { family: 4 | 6; address: string } | null {
  // Forwarding headers are attacker-controlled; bound parsing and allocations.
  if (input.length > 128) return null;
  let value = input.trim();
  if (!value || value.length > 128) return null;

  if (value[0] === "[") {
    const close = value.indexOf("]");
    if (close < 0) return null;
    const remainder = value.slice(close + 1);
    if (remainder && (remainder[0] !== ":" || !validPort(remainder.slice(1)))) return null;
    value = value.slice(1, close);
    return isIpv6(value) ? { family: 6, address: value } : null;
  }

  const firstColon = value.indexOf(":");
  if (firstColon >= 0 && value.indexOf(":", firstColon + 1) < 0) {
    const host = value.slice(0, firstColon);
    if (isIpv4(host) && validPort(value.slice(firstColon + 1))) return { family: 4, address: host };
  }
  if (isIpv4(value)) return { family: 4, address: value };
  return isIpv6(value) ? { family: 6, address: value } : null;
}

/** Masks IP literals without Node APIs because middleware uses the Edge runtime. */
export function maskIpForDebug(input: string): string {
  const parsed = parseIpForMask(input);
  if (!parsed) return "unparseable";
  if (parsed.family === 4) {
    const octets = parsed.address.split(".");
    octets[3] = "0";
    return octets.join(".");
  }

  const ellipsis = String.fromCharCode(0x2026);
  const embeddedIpv4 = parsed.address.indexOf(".");
  if (embeddedIpv4 >= 0) {
    const prefix = parsed.address.slice(0, parsed.address.lastIndexOf(":", embeddedIpv4));
    return prefix ? `${prefix}:${ellipsis}` : ellipsis;
  }
  const compressedAt = parsed.address.indexOf("::");
  const prefix = compressedAt >= 0
    ? parsed.address.slice(0, compressedAt)
    : parsed.address.split(":").slice(0, 4).join(":");
  return prefix ? `${prefix}:${ellipsis}` : ellipsis;
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
    const maskedEntries = forwarded.map(maskIpForDebug);
    const selectedIndex = selected ? forwarded.length - hops : -1;
    console.info(`[rate-limit] xff_entries=${JSON.stringify(maskedEntries)} trusted_proxy_hops=${hops} selected_index=${selectedIndex} selected_ip=${maskIpForDebug(clientIp)}`);
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
