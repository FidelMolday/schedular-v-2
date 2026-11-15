const assert = require("node:assert/strict");
const { test } = require("node:test");
const { signManageToken, verifyManageToken } = require("../lib/manage-token.ts");
const { signWaitlistClaimToken, verifyWaitlistClaimToken } = require("../lib/waitlist-claim-token.ts");

process.env.AUTH_SECRET = "waitlist-claim-test-secret-not-for-production";

test("waitlist claim token verifies entry, expiry, purpose, signature, and token separation", () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const good = signWaitlistClaimToken("entry-1", expiresAt);
  assert.deepEqual(verifyWaitlistClaimToken(good), { entryId: "entry-1", expiresAtMs: expiresAt.getTime() });
  assert.equal(verifyWaitlistClaimToken(good, "entry-2"), null);

  const [encoded, signature] = good.split(".");
  const changedPurpose = Buffer.from(encoded, "base64url").toString("utf8").replace("waitlist-claim-v1", "manage-token-v1");
  const wrongPurpose = `${Buffer.from(changedPurpose).toString("base64url")}.${signature}`;
  assert.equal(verifyWaitlistClaimToken(wrongPurpose), null);
  assert.equal(verifyWaitlistClaimToken(`${encoded}.${signature.slice(0, -1)}x`), null);
  assert.equal(verifyWaitlistClaimToken(signWaitlistClaimToken("entry-1", new Date(Date.now() - 1))), null);

  const manageToken = signManageToken("entry-1", "participant@example.test");
  assert.equal(verifyWaitlistClaimToken(manageToken), null);
  assert.equal(verifyManageToken(good), null);
});
