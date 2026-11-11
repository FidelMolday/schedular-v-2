const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const {
  changeAdminRole,
  promoteToOrgOwner,
  deactivateAdmin,
  reactivateAdmin,
} = require("../lib/data/team.ts");

test("team data-layer role actions enforce roles and expose inactive-actor behavior", async () => {
  const suffix = randomUUID();
  const createdIds = [];
  async function addAdmin(label, role = "admin", isActive = true) {
    const row = await db.admin.create({
      data: {
        name: `Security Test ${label}`,
        initials: "ST",
        email: `${label}.${suffix}@example.invalid`,
        role,
        isActive,
      },
    });
    createdIds.push(row.id);
    return row;
  }

  try {
    const adminActor = await addAdmin("admin-actor");
    const adminChangeTarget = await addAdmin("admin-change-target");
    const adminPromoteTarget = await addAdmin("admin-promote-target");
    const adminDeactivateTarget = await addAdmin("admin-deactivate-target");
    const adminReactivateTarget = await addAdmin("admin-reactivate-target", "admin", false);

    const adminResults = {
      changeAdminRole: await changeAdminRole(adminActor.id, adminChangeTarget.id, "super_admin"),
      promoteToOrgOwner: await promoteToOrgOwner(adminActor.id, adminPromoteTarget.id, adminPromoteTarget.email),
      deactivateAdmin: await deactivateAdmin(adminActor.id, adminDeactivateTarget.id),
      reactivateAdmin: await reactivateAdmin(adminActor.id, adminReactivateTarget.id),
    };
    console.log("RAW admin-role actor results:", JSON.stringify(adminResults));
    assert.deepEqual(adminResults.changeAdminRole, { ok: false, reason: "not_allowed" });
    assert.deepEqual(adminResults.promoteToOrgOwner, { ok: false, reason: "not_org_owner" });
    assert.deepEqual(adminResults.deactivateAdmin, { ok: false, reason: "not_authorized" });
    assert.deepEqual(adminResults.reactivateAdmin, { ok: false, reason: "not_authorized" });

    const inactiveOwnerActors = await Promise.all([
      addAdmin("inactive-owner-change", "org_owner", false),
      addAdmin("inactive-owner-promote", "org_owner", false),
      addAdmin("inactive-owner-deactivate", "org_owner", false),
      addAdmin("inactive-owner-reactivate", "org_owner", false),
    ]);
    const inactiveTargets = await Promise.all([
      addAdmin("inactive-change-target"),
      addAdmin("inactive-promote-target"),
      addAdmin("inactive-deactivate-target"),
      addAdmin("inactive-reactivate-target", "admin", false),
    ]);
    const inactiveOwnerResults = {
      changeAdminRole: await changeAdminRole(inactiveOwnerActors[0].id, inactiveTargets[0].id, "super_admin"),
      promoteToOrgOwner: await promoteToOrgOwner(inactiveOwnerActors[1].id, inactiveTargets[1].id, inactiveTargets[1].email),
      deactivateAdmin: await deactivateAdmin(inactiveOwnerActors[2].id, inactiveTargets[2].id),
      reactivateAdmin: await reactivateAdmin(inactiveOwnerActors[3].id, inactiveTargets[3].id),
    };
    console.log("RAW deactivated org_owner results:", JSON.stringify(inactiveOwnerResults));
    assert.equal(inactiveOwnerResults.changeAdminRole.ok, true);
    assert.equal(inactiveOwnerResults.promoteToOrgOwner.ok, true);
    assert.equal(inactiveOwnerResults.deactivateAdmin.ok, true);
    assert.equal(inactiveOwnerResults.reactivateAdmin.ok, true);

    const activeOwners = await Promise.all([
      addAdmin("active-owner-change", "org_owner"),
      addAdmin("active-owner-promote", "org_owner"),
      addAdmin("active-owner-deactivate", "org_owner"),
      addAdmin("active-owner-reactivate", "org_owner"),
    ]);
    const activeTargets = await Promise.all([
      addAdmin("active-change-target"),
      addAdmin("active-promote-target"),
      addAdmin("active-deactivate-target"),
      addAdmin("active-reactivate-target", "admin", false),
    ]);
    const activeOwnerResults = {
      changeAdminRole: await changeAdminRole(activeOwners[0].id, activeTargets[0].id, "super_admin"),
      promoteToOrgOwner: await promoteToOrgOwner(activeOwners[1].id, activeTargets[1].id, activeTargets[1].email),
      deactivateAdmin: await deactivateAdmin(activeOwners[2].id, activeTargets[2].id),
      reactivateAdmin: await reactivateAdmin(activeOwners[3].id, activeTargets[3].id),
    };
    console.log("RAW active org_owner results:", JSON.stringify(activeOwnerResults));
    for (const result of Object.values(activeOwnerResults)) assert.equal(result.ok, true);
  } finally {
    await db.auditLog.deleteMany({ where: { OR: [{ actorId: { in: createdIds } }, { entityId: { in: createdIds } }] } });
    await db.admin.deleteMany({ where: { id: { in: createdIds } } });
    await db.$disconnect();
  }
});
