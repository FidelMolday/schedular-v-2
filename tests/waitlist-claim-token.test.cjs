const assert = require("node:assert/strict");
const { test } = require("node:test");
const { signManageToken, verifyManageToken } = require("../lib/manage-token.ts");
const { signWaitlistClaimToken, verifyWaitlistClaimToken } = require("../lib/waitlist-claim-token.ts");
const { claimWaitlistOfferAction } = require("../lib/actions.ts");

process.env.AUTH_SECRET = "waitlist-claim-test-secret-not-for-production";

test("waitlist claim action rejects tampered, expired, wrong-entry, and wrong-purpose tokens", async () => {
  const expiresAt = new Date(Date.now() + 60_000);
  const good = signWaitlistClaimToken("entry-1", expiresAt);
  assert.deepEqual(verifyWaitlistClaimToken(good), { entryId: "entry-1", expiresAtMs: expiresAt.getTime() });
  assert.equal(verifyWaitlistClaimToken(good, "entry-2"), null);

  const [encoded, signature] = good.split(".");
  const replaceMiddleBase64UrlCharacter = (segment) => {
    const index = Math.floor(segment.length / 2);
    const replacement = segment[index] === "A" ? "B" : "A";
    return `${segment.slice(0, index)}${replacement}${segment.slice(index + 1)}`;
  };
  const changedPurpose = Buffer.from(encoded, "base64url").toString("utf8").replace("waitlist-claim-v1", "manage-token-v1");
  const wrongPurpose = `${Buffer.from(changedPurpose).toString("base64url")}.${signature}`;
  assert.equal(verifyWaitlistClaimToken(wrongPurpose), null);
  const tamperedSignature = `${encoded}.${replaceMiddleBase64UrlCharacter(signature)}`;
  const tamperedPayload = `${replaceMiddleBase64UrlCharacter(encoded)}.${signature}`;
  const expired = signWaitlistClaimToken("entry-1", new Date(Date.now() - 1));
  assert.equal(verifyWaitlistClaimToken(tamperedSignature), null);
  assert.equal(verifyWaitlistClaimToken(tamperedPayload), null);
  assert.equal(verifyWaitlistClaimToken(expired), null);

  const denials = {
    tamperedSignature: await claimWaitlistOfferAction("entry-1", tamperedSignature),
    tamperedPayload: await claimWaitlistOfferAction("entry-1", tamperedPayload),
    expired: await claimWaitlistOfferAction("entry-1", expired),
    wrongEntry: await claimWaitlistOfferAction("entry-2", good),
    wrongPurpose: await claimWaitlistOfferAction("entry-1", wrongPurpose),
  };
  console.log("RAW token-guarded action denials:", JSON.stringify(denials));
  for (const result of Object.values(denials)) assert.deepEqual(result, { ok: false, reason: "offer_expired" });

  const manageToken = signManageToken("entry-1", "participant@example.test");
  assert.equal(verifyWaitlistClaimToken(manageToken), null);
  assert.equal(verifyManageToken(good), null);
});
