const test = require("node:test");
const assert = require("node:assert/strict");
const { isValidCronAuthorization } = require("../lib/cron-auth.ts");

test("cron authorization rejects wrong and empty secrets and accepts the configured secret", () => {
  assert.equal(isValidCronAuthorization("Bearer wrong-secret", "right-secret"), false);
  assert.equal(isValidCronAuthorization("Bearer ", "right-secret"), false);
  assert.equal(isValidCronAuthorization("Bearer ", ""), false);
  assert.equal(isValidCronAuthorization("Bearer right-secret", "right-secret"), true);
});
