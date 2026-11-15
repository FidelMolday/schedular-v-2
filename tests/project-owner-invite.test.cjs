const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
process.env.AZURE_AD_TENANT_ID ??= "9f6e83db-7a61-4c31-a5d8-1df830f649bf";

let actorId;
const authPath = require.resolve("../auth.ts");
require(authPath);
require.cache[authPath].exports = { auth: async () => ({ user: { id: actorId, name: "Project Test", email: "project-test@example.test" } }) };
require("next/headers").headers = async () => new Headers({ "x-forwarded-for": "127.0.0.44" });
require("next/cache").revalidatePath = () => {};
require("next/navigation").redirect = () => {};

const { db } = require("../lib/db.ts");
const { createProjectAction, inviteAssociateAction } = require("../lib/actions.ts");

process.env.RESEND_API_KEY = "";

function projectInput(name, ownerId) {
  return {
    name, company: "Tests", description: "", durationMinutes: 30,
    dailyStart: "09:00", dailyEnd: "17:00", includeWeekends: true, minNoticeHours: 0,
    timezone: "UTC", bookingDeadlineDays: 0, bufferMinutes: 0, maxSessionsPerAdminPerDay: 10,
    sessionCapacity: 1, availabilityLockDate: new Date(Date.now() + 90 * 86400000),
    branding: { logoInitial: "T", primaryColor: "#111111", senderName: "Tests" },
    availabilityPeriodDays: 30, adminIds: [], ownerId,
  };
}

async function projectDefaults(slug, name, ownerId) {
  return db.project.create({ data: {
    slug, name, company: "Tests", description: "", durationMinutes: 30,
    dailyStart: "09:00", dailyEnd: "17:00", includeWeekends: true, minNoticeHours: 0,
    timezone: "UTC", bookingDeadlineDays: 0, bufferMinutes: 0, maxSessionsPerAdminPerDay: 10,
    availabilityPeriodDays: 30, sessionCapacity: 1, status: "active", availabilityLockDate: new Date(Date.now() + 90 * 86400000),
    brandingLogoInitial: "T", brandingPrimaryColor: "#111111", brandingSenderName: "Tests", ownerId,
  } });
}

test("project creation ignores a super_admin's supplied ownerId; invites are project-scoped", async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const superAdmin = await db.admin.create({ data: { name: "Project Super", initials: "PS", email: `super-${suffix}@example.test`, role: "super_admin" } });
  const otherOwner = await db.admin.create({ data: { name: "Other Owner", initials: "OO", email: `owner-${suffix}@example.test`, role: "super_admin" } });
  actorId = superAdmin.id;
  let created;
  let owned;
  let foreign;
  let invited;
  try {
    const name = `Authz project ${suffix}`;
    try {
      await createProjectAction(projectInput(name, otherOwner.id));
    } catch (error) {
      if (!String(error?.digest ?? "").startsWith("NEXT_REDIRECT;replace;/admin/projects;")) throw error;
    }
    created = await db.project.findFirst({ where: { name }, select: { id: true, ownerId: true } });
    console.log("RAW super_admin project owner:", JSON.stringify({ requestedOwnerId: otherOwner.id, actualOwnerId: created?.ownerId }));
    assert.equal(created.ownerId, superAdmin.id);

    owned = await projectDefaults(`authz-owned-${suffix}`, "Owned Invite Project", superAdmin.id);
    foreign = await projectDefaults(`authz-foreign-${suffix}`, "Foreign Invite Project", otherOwner.id);
    await assert.rejects(
      inviteAssociateAction({ name: "Blocked Invite", email: `blocked-${suffix}@example.test`, projectId: foreign.id }),
      /Forbidden/
    );
    invited = await inviteAssociateAction({ name: "Allowed Invite", email: `allowed-${suffix}@example.test`, projectId: owned.id });
    assert.equal(invited.email, `allowed-${suffix}@example.test`);
    assert.ok(await db.projectAdmin.findUnique({ where: { projectId_adminId: { projectId: owned.id, adminId: invited.id } } }));
    console.log("RAW invite scope:", JSON.stringify({ foreignProject: "rejected", ownedProject: "allowed" }));
  } finally {
    const projectIds = [created?.id, owned?.id, foreign?.id].filter(Boolean);
    await db.auditLog.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.projectAdmin.deleteMany({ where: { projectId: { in: projectIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.admin.deleteMany({ where: { id: { in: [superAdmin.id, otherOwner.id, invited?.id].filter(Boolean) } } });
    await db.$disconnect();
  }
});
