const assert = require("node:assert/strict");
const { test } = require("node:test");
process.env.AZURE_AD_TENANT_ID ??= "9f6e83db-7a61-4c31-a5d8-1df830f649bf";
const { createAuthorizationHelpers } = require("../lib/authz.ts");

function setup({ session, admins = {}, projects = {}, bookings = {} } = {}) {
  return createAuthorizationHelpers({
    getSession: async () => session ?? null,
    findAdmin: async (id) => admins[id] ?? null,
    findProject: async (id) => projects[id] ?? null,
    findBooking: async (id) => bookings[id] ?? null,
  });
}

test("requireActiveSession re-reads active admin identity and role from the DB", async () => {
  const active = setup({
    session: { user: { id: "fresh", role: "org_owner", isActive: false } },
    admins: { fresh: { id: "fresh", role: "admin", isActive: true } },
  });
  assert.deepEqual(await active.requireActiveSession(), { id: "fresh", role: "admin" });

  const noSession = setup();
  await assert.rejects(noSession.requireActiveSession(), /Unauthorized/);
  const deleted = setup({ session: { user: { id: "deleted" } } });
  await assert.rejects(deleted.requireActiveSession(), /Unauthorized/);
  const inactive = setup({
    session: { user: { id: "inactive" } },
    admins: { inactive: { id: "inactive", role: "org_owner", isActive: false } },
  });
  const legacy = await inactive.requireActiveSession((reason) => ({ ok: false, reason }));
  assert.deepEqual(legacy, { ok: false, reason: "unauthorized" });
});

test("requireRole permits only listed fresh roles and supports return-style denials", async () => {
  const helpers = setup({
    session: { user: { id: "actor" } },
    admins: { actor: { id: "actor", role: "super_admin", isActive: true } },
  });
  const actor = await helpers.requireActiveSession();
  assert.deepEqual(helpers.requireRole(actor, ["super_admin"]), actor);
  assert.deepEqual(helpers.requireRole(actor, ["org_owner"], (reason) => ({ ok: false, reason })), {
    ok: false, reason: "forbidden",
  });
  assert.throws(() => helpers.requireRole(actor, ["admin"]), /Forbidden/);
});

test("requireProjectAccess preserves canManageProject owner rules", async () => {
  const helpers = setup({ projects: { owned: { ownerId: "owner" }, ownerless: { ownerId: null } } });
  const owner = { id: "owner", role: "super_admin" };
  const orgOwner = { id: "global", role: "org_owner" };
  const outsider = { id: "other", role: "super_admin" };
  assert.equal(await helpers.requireProjectAccess(owner, "owned"), owner);
  assert.equal(await helpers.requireProjectAccess(orgOwner, "ownerless"), orgOwner);
  await assert.rejects(helpers.requireProjectAccess(outsider, "owned"), /Forbidden/);
  await assert.rejects(helpers.requireProjectAccess(owner, "missing"), /Forbidden/);
});

test("requireBookingAccess permits org owner, project owner, or assigned admin", async () => {
  const helpers = setup({ bookings: {
    assigned: { adminId: "assigned", project: { ownerId: "project-owner" } },
  } });
  const assigned = { id: "assigned", role: "admin" };
  const owner = { id: "project-owner", role: "super_admin" };
  const orgOwner = { id: "global", role: "org_owner" };
  const outsider = { id: "outsider", role: "super_admin" };
  assert.equal(await helpers.requireBookingAccess(assigned, "assigned"), assigned);
  assert.equal(await helpers.requireBookingAccess(owner, "assigned"), owner);
  assert.equal(await helpers.requireBookingAccess(orgOwner, "assigned"), orgOwner);
  await assert.rejects(helpers.requireBookingAccess(outsider, "assigned"), /Forbidden/);
  await assert.rejects(helpers.requireBookingAccess(assigned, "missing"), /Forbidden/);
});

test("five-case authorization matrix rejects absent, wrong-role, wrong-project, and inactive actors", async () => {
  const cases = [];
  const absent = setup();
  cases.push(["no session", async () => await absent.requireActiveSession(), false]);

  const admin = setup({
    session: { user: { id: "admin" } },
    admins: { admin: { id: "admin", role: "admin", isActive: true } },
  });
  const adminActor = await admin.requireActiveSession();
  cases.push(["admin role", async () => admin.requireRole(adminActor, ["org_owner"], () => null), false]);

  const differentProject = setup({ projects: { p1: { ownerId: "someone-else" } } });
  cases.push(["super_admin of another project", async () => differentProject.requireProjectAccess({ id: "super", role: "super_admin" }, "p1", () => null), false]);

  const inactive = setup({ session: { user: { id: "inactive" } }, admins: { inactive: { id: "inactive", role: "org_owner", isActive: false } } });
  cases.push(["deactivated correct role", async () => await inactive.requireActiveSession(() => null), false]);

  const correct = setup({
    session: { user: { id: "owner", role: "admin" } },
    admins: { owner: { id: "owner", role: "super_admin", isActive: true } },
    projects: { own: { ownerId: "owner" } },
  });
  const correctActor = await correct.requireActiveSession();
  cases.push(["correct project owner", async () => await correct.requireProjectAccess(correctActor, "own"), true]);

  const raw = [];
  for (const [label, run, expected] of cases) {
    let allowed = true;
    try {
      const value = await run();
      if (value === null) allowed = false;
    } catch {
      allowed = false;
    }
    raw.push({ label, allowed });
    assert.equal(allowed, expected, label);
  }
  console.log("RAW five-case authorization matrix:", JSON.stringify(raw));
});
