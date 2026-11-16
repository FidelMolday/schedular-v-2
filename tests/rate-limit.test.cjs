const test = require("node:test");
const assert = require("node:assert/strict");
const {
  __resetRateLimitsForTests,
  checkRateLimit,
  checkRateLimitForIpAndAccount,
  getClientIp,
  maskIpForDebug,
} = require("../lib/rate-limit.ts");

test("trusted right-side proxy entry ignores a spoofed leftmost X-Forwarded-For value", () => {
  delete process.env.TRUSTED_PROXY_HOPS;
  __resetRateLimitsForTests();
  const first = getClientIp(new Headers({ "x-forwarded-for": "198.51.100.44, 203.0.113.17" }));
  const changedSpoof = getClientIp(new Headers({ "x-forwarded-for": "192.0.2.99, 203.0.113.17" }));
  assert.equal(first, "203.0.113.17");
  assert.equal(changedSpoof, first);
  assert.equal(checkRateLimit(`signin:ip:${first}`, 1, 60000), true);
  assert.equal(checkRateLimit(`signin:ip:${changedSpoof}`, 1, 60000), false);
});

test("separate client IPs have separate buckets while a normalized account limit follows IP rotation", () => {
  __resetRateLimitsForTests();
  assert.equal(checkRateLimitForIpAndAccount("signin", "198.51.100.1", "Alice@Example.test", 1, 60000), true);
  assert.equal(checkRateLimitForIpAndAccount("signin", "198.51.100.2", "Bob@Example.test", 1, 60000), true);
  assert.equal(checkRateLimitForIpAndAccount("signin", "198.51.100.3", "alice@example.test", 1, 60000), false);
});

test("trusted hop count, fallback, and debug output use configured selection without logging full IPs", () => {
  process.env.TRUSTED_PROXY_HOPS = "2";
  assert.equal(getClientIp(new Headers({ "x-forwarded-for": "192.0.2.5, 198.51.100.8, 203.0.113.21" })), "198.51.100.8");
  assert.equal(getClientIp(new Headers({ "x-forwarded-for": "192.0.2.5", "x-real-ip": "203.0.113.9" })), "203.0.113.9");
  process.env.RATE_LIMIT_DEBUG = "1";
  const logged = [];
  const originalInfo = console.info;
  console.info = (line) => logged.push(line);
  try {
    assert.equal(getClientIp(new Headers({ "x-forwarded-for": "192.0.2.5, 198.51.100.8, 203.0.113.21" })), "198.51.100.8");
  } finally {
    console.info = originalInfo;
    delete process.env.RATE_LIMIT_DEBUG;
    delete process.env.TRUSTED_PROXY_HOPS;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /xff_entries=\["192\.0\.2\.0","198\.51\.100\.0","203\.0\.113\.0"\] trusted_proxy_hops=2 selected_index=1 selected_ip=198\.51\.100\.0/);
  assert.doesNotMatch(logged[0], /198\.51\.100\.8|203\.0\.113\.21|192\.0\.2\.5/);
});

test("debug masks every IPv4 and IPv6 forwarded entry", () => {
  process.env.RATE_LIMIT_DEBUG = "1";
  process.env.TRUSTED_PROXY_HOPS = "1";
  const logged = [];
  const originalInfo = console.info;
  console.info = (line) => logged.push(line);
  try {
    getClientIp(new Headers({ "x-forwarded-for": "192.0.2.123, 2001:db8:abcd:1234::9" }));
  } finally {
    console.info = originalInfo;
    delete process.env.RATE_LIMIT_DEBUG;
    delete process.env.TRUSTED_PROXY_HOPS;
  }
  assert.ok(logged[0].includes(`"192.0.2.0","2001:db8:abcd:1234:${String.fromCharCode(0x2026)}"`));
  assert.doesNotMatch(logged[0], /192\.0\.2\.123|2001:db8:abcd:1234::9/);
});

test("pure JavaScript IP masker handles address forms and rejects malformed input", () => {
  const ellipsis = String.fromCharCode(0x2026);
  const valid = [
    ["203.0.113.84", "203.0.113.0"],
    ["203.0.113.84:443", "203.0.113.0"],
    ["[2001:db8:abcd:1234::9]:443", `2001:db8:abcd:1234:${ellipsis}`],
    ["::ffff:192.0.2.128", `::ffff:${ellipsis}`],
    ["2001:db8::1", `2001:db8:${ellipsis}`],
    ["2001:DB8:ABCD:1234::BEEF", `2001:DB8:ABCD:1234:${ellipsis}`],
    ["  192.0.2.99  ", "192.0.2.0"],
  ];
  for (const [input, expected] of valid) assert.equal(maskIpForDebug(input), expected, input);
  for (const input of ["", "unknown", "garbage", "999.1.2.3", "2001:::1", "x".repeat(129)]) {
    assert.equal(maskIpForDebug(input), "unparseable", JSON.stringify(input));
  }
});

test("debug output marks invalid forwarded values unparseable and keeps hop selection", () => {
  process.env.TRUSTED_PROXY_HOPS = "2";
  process.env.RATE_LIMIT_DEBUG = "1";
  const logged = [];
  const originalInfo = console.info;
  console.info = (line) => logged.push(line);
  try {
    assert.equal(getClientIp(new Headers({ "x-forwarded-for": "garbage, 192.0.2.88, 203.0.113.2" })), "192.0.2.88");
    assert.equal(getClientIp(new Headers({ "x-forwarded-for": "", "x-real-ip": "unknown" })), "unknown");
  } finally {
    console.info = originalInfo;
    delete process.env.RATE_LIMIT_DEBUG;
    delete process.env.TRUSTED_PROXY_HOPS;
  }
  assert.match(logged[0], /xff_entries=\["unparseable","192\.0\.2\.0","203\.0\.113\.0"\] trusted_proxy_hops=2 selected_index=1 selected_ip=192\.0\.2\.0/);
  assert.match(logged[1], /xff_entries=\[\] trusted_proxy_hops=2 selected_index=-1 selected_ip=unparseable/);
});
