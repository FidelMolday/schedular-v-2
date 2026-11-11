const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");

process.env.AUTH_SECRET ??= "authorization-matrix-test-secret";
process.env.RESEND_API_KEY ??= "authorization-matrix-test-key";

const runtime = globalThis.__AUTH_MATRIX__;
const actions = require("../lib/actions.ts");
const projectScoped = new Set([
  "saveAvailabilityAction", "updateProjectAction", "saveTemplateAction", "cancelBookingAction",
  "markBookingCompletedAction", "claimWaitlistOfferAction", "previewDateShiftAction", "commitDateShiftAction",
  "sendTestAction", "addParticipantAction", "sendInvitesNowAction", "removeParticipantAction",
  "manuallyResolveFlaggedBookingAction", "setProjectCertificationRequirementsAction", "getManageLinkAction",
]);
const selfScoped = new Map([
  ["saveAvailabilityAction", "explicitly permits an admin to edit only their own availability"],
  ["markBookingCompletedAction", "requires the caller to be the booking's assigned admin"],
  ["getManageLinkAction", "requires the caller to be an active admin assigned to the booking's project"],
]);

const projectForm = (slug) => ({
  name: `Action Matrix ${slug}`, company: "Test", description: "Fixture", durationMinutes: 30,
  dailyStart: "09:00", dailyEnd: "17:00", includeWeekends: false, minNoticeHours: 1,
  timezone: "Europe/London", bookingDeadlineDays: 30, bufferMinutes: 0,
  maxSessionsPerAdminPerDay: 4, sessionCapacity: 1,
  availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
  branding: { logoInitial: "A", primaryColor: "#000000", senderName: "Action Matrix" },
  availabilityPeriodDays: 30, adminIds: [], status: "draft",
});

function argsFor(name, f, user, suffix) {
  const missing = `matrix-missing-${suffix}`;
  switch (name) {
    case "saveAvailabilityAction": return [f.project.id, user?.id ?? f.outsider.id, []];
    case "createProjectAction": return [projectForm(suffix)];
    case "updateProjectAction": return [f.project.slug, projectForm("updated")];
    case "saveTemplateAction": return [{ category: "reminder", audience: "admin", projectId: f.project.id, subject: "Matrix", bodyHtml: "" }];
    case "cancelBookingAction": return [f.cancelBooking.id, f.project.id];
    case "markBookingCompletedAction": return [f.completionBooking.id];
    case "claimWaitlistOfferAction": return [f.waitlist.id];
    case "previewAdminUnavailableAction":
    case "commitAdminUnavailableAction": return [f.target.id, "2030-01-01", "2030-01-31"];
    case "previewDateShiftAction":
    case "commitDateShiftAction": return [f.project.id, "2030-01-01", "2030-01-31", 1];
    case "sendTestAction": return [f.template.id, "matrix@example.test"];
    case "inviteAssociateAction": return [{ name: "Matrix existing owner", email: f.owner.email, projectId: f.project.id, role: "admin" }];
    case "changeAdminRoleAction": return [missing, "admin"];
    case "promoteToOrgOwnerAction": return [missing, "PROMOTE"];
    case "deactivateAdminAction":
    case "reactivateAdminAction": return [missing];
    case "saveAvailabilityRangesAction": return ["2040-01-01", []];
    case "addParticipantAction": return [f.project.id, "Matrix participant", `participant-${suffix}@example.test`];
    case "sendInvitesNowAction": return [f.project.id, []];
    case "removeParticipantAction": return [f.participant.id];
    case "manuallyResolveFlaggedBookingAction": return [f.flaggedBooking.id, f.assigned.id];
    case "createCertificationAction": return [""];
    case "updateCertificationAction": return [missing, "Matrix", ""];
    case "deleteCertificationAction": return [missing];
    case "setAdminCertificationsAction": return [f.target.id, []];
    case "setProjectCertificationRequirementsAction": return [f.project.id, []];
    case "createSessionTypeAction": return [""];
    case "updateSessionTypeAction": return [missing, "Matrix"];
    case "deleteSessionTypeAction":
    case "reactivateSessionTypeAction": return [missing];
    case "createZoomAccountAction": return [{ label: "", zoomUserId: "", zoomEmail: "" }];
    case "setZoomAccountActiveAction": return [missing, true];
    case "deleteZoomAccountAction": return [missing];
    case "syncZoomPoolAction":
    case "getZoomPoolStatusAction": return [];
    case "updateNotificationPreferencesAction": return [true];
    case "getManageLinkAction": return [f.completionBooking.id];
    default: throw new Error(`No action matrix arguments registered for ${name}`);
  }
}

function authRejected(name, outcome, user) {
  const text = `${outcome.error ?? ""} ${JSON.stringify(outcome.value) ?? ""}`.toLowerCase();
  if (!user || !user.isActive) return name !== "getZoomPoolStatusAction";
  if (/unauthori[sz]ed|forbidden|not_allowed|not_authorized|not_org_owner|not_assigned/.test(text)) return true;
  if (name === "createProjectAction" && user.role === "admin") return true;
  if (name === "inviteAssociateAction" && user.role === "admin") return true;
  return false;
}

async function call(name, user, f, suffix) {
  runtime.session = user && !user.isActive ? null : user
    ? { user: { id: user.id, name: user.name, email: user.email, role: user.role }, expires: new Date(Date.now() + 60_000).toISOString() }
    : null;
  runtime.redirectTarget = null;
  try {
    const value = await actions[name](...argsFor(name, f, user, suffix));
    return { error: null, value, redirect: runtime.redirectTarget };
  } catch (error) {
    return { error: error.message, value: null, redirect: runtime.redirectTarget };
  }
}

test("non-public server actions run through the five-case authorization matrix", async () => {
  const suffix = randomUUID();
  const ids = [];
  async function addAdmin(label, role = "admin", isActive = true) {
    const row = await db.admin.create({ data: { name: `Action Matrix ${label}`, initials: "AM", email: `${label}.${suffix}@example.test`, role, isActive } });
    ids.push(row.id);
    return row;
  }
  let projectId;
  let createdProjectPrefix;
  try {
    const owner = await addAdmin("owner", "org_owner");
    const target = await addAdmin("target");
    const assigned = await addAdmin("assigned");
    const outsider = await addAdmin("outsider");
    const superAdmin = await addAdmin("super", "super_admin");
    const inactiveOwner = await addAdmin("inactive-owner", "org_owner", false);
    const project = await db.project.create({
      data: {
        slug: `action-matrix-${suffix}`, name: "Action Matrix project", company: "Test", description: "Fixture",
        durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
        minNoticeHours: 1, timezone: "Europe/London", bookingDeadlineDays: 30, bufferMinutes: 0,
        maxSessionsPerAdminPerDay: 4, availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
        brandingLogoInitial: "A", brandingPrimaryColor: "#000000", brandingSenderName: "Action Matrix", ownerId: owner.id, status: "active",
      },
    });
    projectId = project.id;
    await db.projectAdmin.createMany({ data: [{ projectId, adminId: target.id }, { projectId, adminId: assigned.id }] });
    const participant = await db.participant.create({ data: { projectId, name: "Matrix participant", email: `participant.${suffix}@example.test` } });
    const template = await db.emailTemplate.create({ data: { category: "reminder", audience: "admin", projectId, subject: "Matrix", bodyHtml: "Hello" } });
    const completionBooking = await db.booking.create({ data: { projectId, adminId: target.id, participantName: "Matrix completion", participantEmail: `completion.${suffix}@example.test`, dateKey: "2020-01-01", time: "10:00" } });
    const cancelBooking = await db.booking.create({ data: { projectId, adminId: target.id, participantName: "Matrix cancel", participantEmail: `cancel.${suffix}@example.test`, dateKey: "2030-01-01", time: "10:00" } });
    const flaggedBooking = await db.booking.create({ data: { projectId, adminId: target.id, participantName: "Matrix flagged", participantEmail: `flagged.${suffix}@example.test`, dateKey: "2030-01-01", time: "11:00", needsManualAttention: true, manualAttentionReason: "matrix" } });
    const waitlist = await db.waitlistEntry.create({ data: { projectId, name: "Matrix waiter", email: `waiter.${suffix}@example.test`, dateKey: "2040-01-01", time: "10:00", status: "offered", offeredAt: new Date(), expiresAt: new Date("2040-01-02T00:00:00Z") } });
    createdProjectPrefix = `action-matrix-${suffix}`;
    const fixture = { owner, target, assigned, outsider, superAdmin, project, participant, template, completionBooking, cancelBooking, flaggedBooking, waitlist };
    const scenarios = [
      ["no session", null],
      ["admin not on target project", outsider],
      ["super_admin not owner", superAdmin],
      ["deactivated otherwise-correct role", inactiveOwner],
      ["correct role and owner", owner],
    ];
    const rows = [];
    for (const name of Object.keys(actions)) {
      if (name === "confirmBookingAction" || name === "joinWaitlistAction" || name === "getFilteredAvailabilityAction") continue;
      if (name === "getZoomPoolStatusAction") {
        // It has no auth() call in its body; keep it in the matrix to expose the missing check.
      }
      const results = [];
      for (const [scenario, user] of scenarios) {
        const actionUser = scenario === "correct role and owner" && ["markBookingCompletedAction", "getManageLinkAction"].includes(name) ? target : user;
        const outcome = await call(name, actionUser, fixture, `${suffix}-${scenario.replace(/\W+/g, "-")}`);
        results.push({ scenario, authOutcome: authRejected(name, outcome, user) ? "rejected" : "allowed", error: outcome.error, reason: outcome.value?.reason ?? null, redirect: outcome.redirect });
      }
      rows.push({ function: name, projectScoped: projectScoped.has(name), selfScopedReason: selfScoped.get(name) ?? null, results });
    }

    const noSessionFailures = rows.filter((row) => row.results[0].authOutcome !== "rejected").map((row) => row.function);
    const inactiveFailures = rows.filter((row) => row.results[3].authOutcome !== "rejected").map((row) => row.function);
    const allowedPathFailures = rows.filter((row) => row.results[4].authOutcome !== "allowed").map((row) => row.function);
    const adminScopeFailures = rows.filter((row) => row.projectScoped && !row.selfScopedReason && row.results[1].authOutcome !== "rejected")
      .map((row) => ({ function: row.function, output: row.results[1] }));
    const superAdminScopeFailures = rows.filter((row) => row.projectScoped && row.results[2].authOutcome !== "rejected")
      .map((row) => ({ function: row.function, output: row.results[2] }));
    const actionSource = fs.readFileSync(require.resolve("../lib/actions.ts"), "utf8");
    const lineFor = (name) => actionSource.slice(0, actionSource.indexOf(`export async function ${name}`)).split("\n").length;
    const findings = {
      noSessionFailures: noSessionFailures.map((name) => ({ function: name, line: lineFor(name), output: rows.find((row) => row.function === name).results[0] })),
      inactiveFailures: inactiveFailures.map((name) => ({ function: name, line: lineFor(name), output: rows.find((row) => row.function === name).results[3] })),
      allowedPathFailures,
      adminScopeFailures: adminScopeFailures.map((item) => ({ ...item, line: lineFor(item.function) })),
      superAdminScopeFailures: superAdminScopeFailures.map((item) => ({ ...item, line: lineFor(item.function) })),
    };
    console.log("RAW action matrix counts:", JSON.stringify({ entrypoints: rows.length, cases: rows.length * 5, findings }));
    console.log("RAW action matrix outcomes:", JSON.stringify({ noSession: rows.filter((row) => row.results[0].authOutcome === "rejected").length, adminRole: rows.filter((row) => row.results[1].authOutcome === "rejected").length, superAdmin: rows.filter((row) => row.results[2].authOutcome === "rejected").length, deactivated: rows.filter((row) => row.results[3].authOutcome === "rejected").length, allowedOwner: rows.filter((row) => row.results[4].authOutcome === "allowed").length }));
    assert.equal(rows.length, 38, "every non-public lib/actions.ts export must be invoked");
    assert.deepEqual(noSessionFailures, []);
    assert.deepEqual(inactiveFailures, []);
    assert.deepEqual(allowedPathFailures, []);
    assert.deepEqual(adminScopeFailures, [], "non-project members must be rejected by project-scoped actions unless self-scoped");
    assert.deepEqual(superAdminScopeFailures, [], "non-owning super_admin must be rejected by project-scoped actions");
  } finally {
    runtime.session = null;
    runtime.redirectTarget = null;
    if (projectId) await db.project.deleteMany({ where: { id: projectId } });
    await db.project.deleteMany({ where: { slug: { startsWith: createdProjectPrefix ?? "__no_action_matrix_projects__" } } });
    await db.admin.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
