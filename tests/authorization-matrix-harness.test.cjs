const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");

const runtime = globalThis.__AUTH_MATRIX__;
const actions = require("../lib/actions.ts");
const projectsRoute = require("../app/api/projects/route.ts");
const shiftRoute = require("../app/api/reschedule/preview-date-shift/route.ts");

function session(user) {
  return user ? { user: { id: user.id, name: user.name, email: user.email, role: user.role }, expires: new Date(Date.now() + 60_000).toISOString() } : null;
}

async function resultOf(call) {
  try {
    const result = await call();
    if (typeof result?.status === "number") {
      return { outcome: result.status >= 400 ? "rejected" : "allowed", result };
    }
    return { outcome: "allowed", result: "returned" };
  } catch (error) {
    return { outcome: "rejected", error: error.message };
  }
}

function request(projectId) {
  return new Request("http://localhost/api/reschedule/preview-date-shift", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, fromDate: "2030-01-01", toDate: "2030-01-31", offsetDays: 1 }),
  });
}

test("authorization matrix harness invokes an action and GET/POST routes across five session scenarios", async () => {
  const suffix = randomUUID();
  const ids = {};
  const createdAdminIds = [];
  async function addAdmin(label, role = "admin", isActive = true) {
    const row = await db.admin.create({ data: { name: `Matrix ${label}`, initials: "MX", email: `${label}.${suffix}@example.test`, role, isActive } });
    createdAdminIds.push(row.id);
    ids[label] = row;
    return row;
  }
  let projectId;
  try {
    await addAdmin("owner", "org_owner");
    await addAdmin("unrelated", "admin");
    await addAdmin("super", "super_admin");
    await addAdmin("inactive-owner", "org_owner", false);
    const project = await db.project.create({
      data: {
        slug: `matrix-${suffix}`, name: "Matrix project", company: "Test", description: "Matrix fixture",
        durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
        minNoticeHours: 1, timezone: "Europe/London", bookingDeadlineDays: 30, bufferMinutes: 0,
        maxSessionsPerAdminPerDay: 4, availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
        brandingLogoInitial: "M", brandingPrimaryColor: "#000000", brandingSenderName: "Matrix",
        ownerId: ids.owner.id,
      },
    });
    projectId = project.id;

    const scenarios = [
      ["no session", null],
      ["admin not on target project", ids.unrelated],
      ["super_admin not owner", ids.super],
      ["deactivated otherwise-correct role", ids["inactive-owner"]],
      ["correct role and owner", ids.owner],
    ];
    const rows = [];
    for (const [label, user] of scenarios) {
      runtime.session = user && !user.isActive ? null : session(user);
      const action = await resultOf(() => actions.saveAvailabilityAction(projectId, user?.id ?? ids.owner.id, []));
      const get = await resultOf(async () => {
        const response = await projectsRoute.GET();
        return { status: response.status, projects: await response.json() };
      });
      const post = await resultOf(async () => {
        const response = await shiftRoute.POST(request(projectId));
        return { status: response.status, body: await response.json() };
      });
      rows.push({ scenario: label, action, getProjects: get, postPreviewDateShift: post });
    }
    console.log("RAW authorization harness matrix:", JSON.stringify(rows));
    const superAdminProjects = rows[2].getProjects.result.projects;
    const nonOwnedProjectIds = superAdminProjects.filter((item) => item.ownerId !== ids.super.id).map((item) => item.id);
    console.log("RAW GET /api/projects super_admin non-owner project IDs:", JSON.stringify(nonOwnedProjectIds));
    assert.equal(rows.length, 5);
    assert.match(rows[0].action.error, /Unauthorized/);
    assert.equal(rows[0].getProjects.result.status, 401);
    assert.equal(rows[0].postPreviewDateShift.result.status, 401);
    assert.equal(rows[1].postPreviewDateShift.result.status, 403);
    assert.equal(rows[3].postPreviewDateShift.result.status, 401);
    assert.equal(rows[4].action.outcome, "allowed");
    assert.equal(rows[4].getProjects.result.status, 200);
    assert.equal(rows[4].postPreviewDateShift.result.status, 200);
    assert.ok(nonOwnedProjectIds.includes(projectId), "candidate: super_admin receives a project owned by another user");
  } finally {
    runtime.session = null;
    if (projectId) await db.project.deleteMany({ where: { id: projectId } });
    await db.admin.deleteMany({ where: { id: { in: createdAdminIds } } });
    await db.$disconnect();
  }
});
