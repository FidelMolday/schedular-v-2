const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const resetRoute = require("../app/api/auth/request-password-reset/route.ts");
const setupRoute = require("../app/api/auth/setup-password/route.ts");

function hashToken(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("inactive and missing admins get generic reset/setup responses; active token setup still works", async () => {
  const suffix = randomUUID();
  const inactive = await db.admin.create({
    data: { name: "Inactive Reset Test", initials: "IR", email: `inactive-${suffix}@example.test`, isActive: false },
  });
  const active = await db.admin.create({
    data: { name: "Active Setup Test", initials: "AS", email: `active-${suffix}@example.test`, isActive: true },
  });
  const inactiveRaw = `inactive-token-${suffix}`;
  const activeRaw = `active-token-${suffix}`;
  try {
    await db.passwordResetToken.createMany({ data: [
      { adminId: inactive.id, token: hashToken(inactiveRaw), expires: new Date(Date.now() + 60_000) },
      { adminId: active.id, token: hashToken(activeRaw), expires: new Date(Date.now() + 60_000) },
    ] });

    const inactiveReset = await resetRoute.POST(new Request("http://localhost/api/auth/request-password-reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: inactive.email }),
    }));
    const missingReset = await resetRoute.POST(new Request("http://localhost/api/auth/request-password-reset", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `missing-${suffix}@example.test` }),
    }));
    const inactiveResetBody = await inactiveReset.json();
    const missingResetBody = await missingReset.json();
    console.log("RAW reset response inactive:", JSON.stringify({ status: inactiveReset.status, body: inactiveResetBody }));
    console.log("RAW reset response missing:", JSON.stringify({ status: missingReset.status, body: missingResetBody }));
    assert.deepEqual(inactiveResetBody, { ok: true });
    assert.deepEqual(missingResetBody, inactiveResetBody);

    const inactiveGet = await setupRoute.GET(new Request(`http://localhost/api/auth/setup-password?token=${inactiveRaw}`));
    const invalidGet = await setupRoute.GET(new Request(`http://localhost/api/auth/setup-password?token=missing-${suffix}`));
    const inactiveGetBody = await inactiveGet.json();
    console.log("RAW setup GET inactive:", JSON.stringify({ status: inactiveGet.status, body: inactiveGetBody }));
    assert.deepEqual(inactiveGetBody, await invalidGet.json());
    assert.equal(inactiveGetBody.valid, false);

    const inactivePost = await setupRoute.POST(new Request("http://localhost/api/auth/setup-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inactiveRaw, password: "A-strong-test-password-123" }),
    }));
    const invalidPost = await setupRoute.POST(new Request("http://localhost/api/auth/setup-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `missing-${suffix}`, password: "A-strong-test-password-123" }),
    }));
    const inactivePostBody = await inactivePost.json();
    console.log("RAW setup POST inactive:", JSON.stringify({ status: inactivePost.status, body: inactivePostBody }));
    assert.equal(inactivePost.status, 404);
    assert.deepEqual(inactivePostBody, await invalidPost.json());

    const activeGet = await setupRoute.GET(new Request(`http://localhost/api/auth/setup-password?token=${activeRaw}`));
    const activeGetBody = await activeGet.json();
    assert.equal(activeGetBody.valid, true);
    const activePost = await setupRoute.POST(new Request("http://localhost/api/auth/setup-password", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: activeRaw, password: "A-strong-test-password-123" }),
    }));
    console.log("RAW setup POST active:", JSON.stringify({ status: activePost.status, body: await activePost.json() }));
    assert.equal(activePost.status, 200);
    assert.ok((await db.admin.findUnique({ where: { id: active.id }, select: { passwordHash: true } })).passwordHash);
  } finally {
    await db.admin.deleteMany({ where: { id: { in: [inactive.id, active.id] } } });
    await db.$disconnect();
  }
});
