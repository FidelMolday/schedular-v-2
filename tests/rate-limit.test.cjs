const test = require("node:test");
const assert = require("node:assert/strict");
const {
  __resetRateLimitsForTests,
  checkRateLimit,
  checkRateLimitForIpAndAccount,
  getClientIp,
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

test("trusted hop count, fallback, and debug output use the configured selection without logging full IPs", () => {
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
  assert.match(logged[0], /\["192\.0\.2\.0","2001:db8:abcd:1234:…"\]/);
  assert.doesNotMatch(logged[0], /192\.0\.2\.123|2001:db8:abcd:1234::9/);
});
