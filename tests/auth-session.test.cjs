const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const { refreshActiveAdminToken, projectActiveAdminSession } = require("../lib/auth-session.ts");

test("live sessions are rejected after deactivation or deletion", async () => {
  const suffix = randomUUID();
  const createdIds = [];
  async function addAdmin(label) {
    const admin = await db.admin.create({
      data: { name: `Session Test ${label}`, initials: "ST", email: `${label}.${suffix}@example.test` },
    });
    createdIds.push(admin.id);
    return admin;
  }
  const session = { user: { name: "Session Test", email: "owner@example.test" }, expires: new Date(Date.now() + 60_000).toISOString() };

  try {
    const deactivated = await addAdmin("deactivated");
    const deleted = await addAdmin("deleted");
    const active = await addAdmin("active");
    const liveDeactivatedToken = { sub: deactivated.id, role: "admin", isActive: true };
    const liveDeletedToken = { sub: deleted.id, role: "admin", isActive: true };
    const activeToken = { sub: active.id, role: "admin", isActive: true };

    await db.admin.update({ where: { id: deactivated.id }, data: { isActive: false } });
    await db.admin.delete({ where: { id: deleted.id } });

    const deactivatedRefresh = await refreshActiveAdminToken(liveDeactivatedToken, db);
    const deletedRefresh = await refreshActiveAdminToken(liveDeletedToken, db);
    const activeRefresh = await refreshActiveAdminToken(activeToken, db);
    const outcomes = {
      deactivatedNextRequest: { refreshedToken: deactivatedRefresh, session: projectActiveAdminSession(session, { ...liveDeactivatedToken, isActive: false }) },
      deletedNextRequest: { refreshedToken: deletedRefresh, session: projectActiveAdminSession(session, { ...liveDeletedToken, isActive: false }) },
      activeNextRequest: { refreshedToken: activeRefresh, hasUser: !!projectActiveAdminSession(session, activeRefresh) },
    };
    console.log("RAW session validation outcomes:", JSON.stringify(outcomes));
    assert.equal(outcomes.deactivatedNextRequest.refreshedToken, null);
    assert.equal(outcomes.deactivatedNextRequest.session, null);
    assert.equal(outcomes.deletedNextRequest.refreshedToken, null);
    assert.equal(outcomes.deletedNextRequest.session, null);
    assert.equal(outcomes.activeNextRequest.hasUser, true);
  } finally {
    await db.admin.deleteMany({ where: { id: { in: createdIds } } });
    await db.$disconnect();
  }
});
