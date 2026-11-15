const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");

const runtime = globalThis.__AUTH_MATRIX__;
const { saveAvailabilityAction } = require("../lib/actions.ts");

function session(user) {
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, expires: new Date(Date.now() + 60_000).toISOString() };
}

test("saveAvailabilityAction permits self, org_owner, and an owning super_admin only", async () => {
  const suffix = randomUUID();
  const adminIds = [];
  const projectIds = [];
  async function addAdmin(label, role) {
    const admin = await db.admin.create({ data: { name: `Availability ${label}`, initials: "AV", email: `${label}.${suffix}@example.test`, role } });
    adminIds.push(admin.id);
    return admin;
  }
  async function addProject(label, ownerId) {
    const project = await db.project.create({
      data: {
        slug: `availability-${label}-${suffix}`, name: `Availability ${label}`, company: "Test", description: "Fixture",
        durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
        minNoticeHours: 1, timezone: "UTC", bookingDeadlineDays: 0, bufferMinutes: 0,
        maxSessionsPerAdminPerDay: 4, availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
        brandingLogoInitial: "A", brandingPrimaryColor: "#000000", brandingSenderName: "Availability", ownerId,
      },
    });
    projectIds.push(project.id);
    return project;
  }
  try {
    const owner = await addAdmin("owner", "org_owner");
    const target = await addAdmin("target", "admin");
    const owningSuper = await addAdmin("owning-super", "super_admin");
    const foreignSuper = await addAdmin("foreign-super", "super_admin");
    const ownerProject = await addProject("owner", owner.id);
    const superProject = await addProject("super", owningSuper.id);
    await db.projectAdmin.createMany({ data: [
      { projectId: ownerProject.id, adminId: target.id },
      { projectId: superProject.id, adminId: target.id },
    ] });

    async function attempt(actor, projectId, dateKey) {
      runtime.session = session(actor);
      try {
        await saveAvailabilityAction(projectId, target.id, [{ dateKey, time: "09:00", selected: true }]);
        return { outcome: "allowed" };
      } catch (error) {
        return { outcome: "rejected", error: error.message };
      }
    }

    const cases = {
      self: await attempt(target, ownerProject.id, "2041-01-01"),
      org_owner: await attempt(owner, ownerProject.id, "2041-01-02"),
      owning_super_admin: await attempt(owningSuper, superProject.id, "2041-01-03"),
      non_owning_super_admin: await attempt(foreignSuper, ownerProject.id, "2041-01-04"),
    };
    console.log("RAW saveAvailabilityAction role matrix:", JSON.stringify(cases));

    assert.deepEqual(cases.self, { outcome: "allowed" });
    assert.deepEqual(cases.org_owner, { outcome: "allowed" });
    assert.deepEqual(cases.owning_super_admin, { outcome: "allowed" });
    assert.deepEqual(cases.non_owning_super_admin, { outcome: "rejected", error: "Unauthorized" });
    const saved = await db.adminAvailability.count({ where: { adminId: target.id } });
    assert.equal(saved, 3, "only legitimate callers save availability");
  } finally {
    runtime.session = null;
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.admin.deleteMany({ where: { id: { in: adminIds } } });
    await db.$disconnect();
  }
});
