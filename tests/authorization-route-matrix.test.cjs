const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const { NextRequest } = require("next/server");

const runtime = globalThis.__AUTH_MATRIX__;
const routes = {
  "GET /api/team-availability": require("../app/api/team-availability/route.ts").GET,
  "GET /api/super-admins": require("../app/api/super-admins/route.ts").GET,
  "POST /api/reschedule/preview-date-shift": require("../app/api/reschedule/preview-date-shift/route.ts").POST,
  "POST /api/reschedule/commit-date-shift": require("../app/api/reschedule/commit-date-shift/route.ts").POST,
  "POST /api/reschedule/preview-admin-unavailable": require("../app/api/reschedule/preview-admin-unavailable/route.ts").POST,
  "POST /api/reschedule/commit-admin-unavailable": require("../app/api/reschedule/commit-admin-unavailable/route.ts").POST,
  "GET /api/reports/[type]": require("../app/api/reports/[type]/route.ts").GET,
  "POST /api/participants/import": require("../app/api/participants/import/route.ts").POST,
  "GET /api/calendar": require("../app/api/calendar/route.ts").GET,
  "GET /api/projects": require("../app/api/projects/route.ts").GET,
  "GET /api/availability-ranges": require("../app/api/availability-ranges/route.ts").GET,
  "GET /api/analytics": require("../app/api/analytics/route.ts").GET,
  "GET /api/graph-status": require("../app/api/graph-status/route.ts").GET,
  "GET /api/admins": require("../app/api/admins/route.ts").GET,
  "GET /api/dashboard/admin": require("../app/api/dashboard/admin/route.ts").GET,
};

function req(path, body, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function session(user) {
  return user ? { user: { id: user.id, name: user.name, email: user.email, role: user.role }, expires: new Date(Date.now() + 60_000).toISOString() } : null;
}

function responseFor(name, fn, fixture) {
  const { owner, unrelated, superAdmin, project } = fixture;
  if (name.includes("reschedule/preview-date-shift") || name.includes("reschedule/commit-date-shift")) {
    return fn(req("/api/reschedule", { projectId: project.id, fromDate: "2030-01-01", toDate: "2030-01-31", offsetDays: 1 }, "POST"));
  }
  if (name.includes("reschedule/preview-admin-unavailable") || name.includes("reschedule/commit-admin-unavailable")) {
    return fn(req("/api/reschedule", { adminId: unrelated.id, fromDate: "2030-01-01", toDate: "2030-01-31" }, "POST"));
  }
  if (name === "GET /api/team-availability") return fn(req("/api/team-availability?from=2030-01-01&to=2030-01-31&projectId=" + project.id));
  if (name === "GET /api/reports/[type]") return fn(req("/api/reports/bookings-summary"), { params: Promise.resolve({ type: "bookings-summary" }) });
  if (name === "POST /api/participants/import") {
    const form = new FormData();
    form.set("projectId", project.slug);
    form.set("file", new File([""], "empty.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    return fn(new Request("http://localhost/api/participants/import", { method: "POST", body: form }));
  }
  if (name === "GET /api/calendar") return fn(req("/api/calendar?from=2030-01-01&to=2030-01-31&projectId=" + project.id));
  if (name === "GET /api/availability-ranges") return fn(req("/api/availability-ranges?fromDate=2030-01-01&toDate=2030-01-31"));
  if (name === "GET /api/analytics") return fn(req("/api/analytics?from=2030-01-01&to=2030-01-31&projectId=" + project.id));
  if (name === "GET /api/graph-status") return fn(req(`/api/graph-status?adminId=${unrelated.id}`));
  if (name === "GET /api/dashboard/admin") return fn(req(`/api/dashboard/admin?adminId=${unrelated.id}`));
  return fn();
}

async function invoke(name, fn, fixture, user) {
  runtime.session = user && !user.isActive ? null : session(user);
  try {
    const response = await responseFor(name, fn, fixture);
    if (response instanceof Response) {
      return { outcome: response.status === 401 || response.status === 403 ? "rejected" : "allowed", status: response.status, body: await response.json().catch(() => null) };
    }
    return { outcome: "allowed", result: response };
  } catch (error) {
    return { outcome: "rejected", error: error.message };
  }
}

test("authenticated route handlers are invoked across the authorization matrix", async () => {
  const suffix = randomUUID();
  const admins = [];
  async function addAdmin(label, role = "admin", isActive = true) {
    const row = await db.admin.create({ data: { name: `Route Matrix ${label}`, initials: "RM", email: `${label}.${suffix}@example.test`, role, isActive } });
    admins.push(row.id);
    return row;
  }
  let projectId;
  try {
    const owner = await addAdmin("owner", "org_owner");
    const unrelated = await addAdmin("unrelated");
    const outsider = await addAdmin("outsider");
    const superAdmin = await addAdmin("super", "super_admin");
    const inactiveOwner = await addAdmin("inactive-owner", "org_owner", false);
    const project = await db.project.create({
      data: {
        slug: `route-matrix-${suffix}`, name: "Route Matrix project", company: "Test", description: "Fixture",
        durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
        minNoticeHours: 1, timezone: "Europe/London", bookingDeadlineDays: 30, bufferMinutes: 0,
        maxSessionsPerAdminPerDay: 4, availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
        brandingLogoInitial: "R", brandingPrimaryColor: "#000000", brandingSenderName: "Route Matrix", ownerId: owner.id,
      },
    });
    projectId = project.id;
    const fixture = { owner, unrelated, outsider, superAdmin, project };
    const cases = [];
    for (const [name, fn] of Object.entries(routes)) {
      const matrix = [];
      matrix.push(["no session", await invoke(name, fn, fixture, null)]);
      matrix.push(["admin not on target project", await invoke(name, fn, fixture, outsider)]);
      matrix.push(["super_admin not owner", await invoke(name, fn, fixture, superAdmin)]);
      matrix.push(["deactivated correct role", await invoke(name, fn, fixture, inactiveOwner)]);
      matrix.push(["correct owner role", await invoke(name, fn, fixture, owner)]);
      cases.push({ entrypoint: name, matrix });
    }
    const compact = cases.map(({ entrypoint, matrix }) => ({
      entrypoint,
      cases: matrix.map(([scenario, result]) => ({ scenario, outcome: result.outcome, status: result.status ?? null, error: result.error ?? null })),
    }));
    console.log("RAW authenticated route matrix outcomes:", JSON.stringify(compact));
    assert.equal(Object.keys(routes).length, 15);
    for (const row of cases) {
      assert.equal(row.matrix.length, 5);
      assert.equal(row.matrix[0][1].outcome, "rejected", `${row.entrypoint} must reject no session`);
      assert.equal(row.matrix[3][1].outcome, "rejected", `${row.entrypoint} must reject deactivated identity`);
    }
  } finally {
    runtime.session = null;
    if (projectId) await db.project.deleteMany({ where: { id: projectId } });
    await db.admin.deleteMany({ where: { id: { in: admins } } });
    await db.$disconnect();
  }
});
