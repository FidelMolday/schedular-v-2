const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { NextRequest } = require("next/server");
const { db } = require("../lib/db.ts");
const { checkAdminUnavailableAccess } = require("../lib/admin-unavailable-access.ts");
const { commitAdminUnavailable } = require("../lib/data/bulk-reschedule.ts");
const { previewAdminUnavailableAction, commitAdminUnavailableAction } = require("../lib/actions.ts");

const runtime = globalThis.__AUTH_MATRIX__;
const previewRoute = require("../app/api/reschedule/preview-admin-unavailable/route.ts");
const commitRoute = require("../app/api/reschedule/commit-admin-unavailable/route.ts");

function session(user) {
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, expires: new Date(Date.now() + 60_000).toISOString() };
}

test("admin-unavailable routes scope every affected project before preview or commit", async () => {
  const suffix = randomUUID();
  const adminIds = [];
  const projectIds = [];
  const bookingIds = [];
  async function addAdmin(label, role = "admin", isActive = true) {
    const admin = await db.admin.create({ data: { name: `Unavailable ${label}`, initials: "UA", email: `${label}.${suffix}@example.test`, role, isActive } });
    adminIds.push(admin.id);
    return admin;
  }
  async function addProject(label, ownerId) {
    const project = await db.project.create({
      data: {
        slug: `unavailable-${label}-${suffix}`, name: `Unavailable ${label}`, company: "Test", description: "Fixture",
        durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
        minNoticeHours: 1, timezone: "UTC", bookingDeadlineDays: 0, bufferMinutes: 0,
        maxSessionsPerAdminPerDay: 4, availabilityLockDate: new Date("2030-01-01T00:00:00Z"),
        brandingLogoInitial: "U", brandingPrimaryColor: "#000000", brandingSenderName: "Unavailable", ownerId,
      },
    });
    projectIds.push(project.id);
    return project;
  }
  async function addAffectedBooking(project, target, replacement, dateKey) {
    await db.projectAdmin.createMany({ data: [
      { projectId: project.id, adminId: target.id },
      { projectId: project.id, adminId: replacement.id },
    ], skipDuplicates: true });
    await db.adminAvailabilityRange.create({ data: { adminId: replacement.id, dateKey, startTime: "09:00", endTime: "12:00" } });
    const booking = await db.booking.create({ data: {
      projectId: project.id, adminId: target.id, participantName: `Participant ${dateKey}`,
      participantEmail: `participant-${dateKey}.${suffix}@example.test`, dateKey, time: "10:00", status: "confirmed",
    } });
    bookingIds.push(booking.id);
    return booking;
  }
  function request(dateKey, dateTo = dateKey) {
    return new NextRequest("http://localhost/api/reschedule/admin-unavailable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminId: target.id, fromDate: dateKey, toDate: dateTo }),
    });
  }
  async function call(route, actor, fromDate, toDate = fromDate) {
    runtime.session = actor ? session(actor) : null;
    const response = await route.POST(request(fromDate, toDate));
    return { status: response.status, body: await response.json() };
  }
  async function snapshot(ids) {
    return db.booking.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  }

  let target;
  try {
    const owningSuper = await addAdmin("owning-super", "super_admin");
    const foreignOwner = await addAdmin("foreign-owner", "org_owner");
    const orgOwner = await addAdmin("org-owner", "org_owner");
    const deactivatedOwner = await addAdmin("inactive-owner", "org_owner", false);
    target = await addAdmin("target");
    const ownedReplacement = await addAdmin("owned-replacement");
    const foreignReplacement = await addAdmin("foreign-replacement");
    const unownedReplacement = await addAdmin("unowned-replacement");
    const ownedProject = await addProject("owned", owningSuper.id);
    const foreignProject = await addProject("foreign", foreignOwner.id);
    const unownedProject = await addProject("ownerless", null);
    const ownedBooking = await addAffectedBooking(ownedProject, target, ownedReplacement, "2042-01-01");
    const foreignBooking = await addAffectedBooking(foreignProject, target, foreignReplacement, "2042-01-02");
    const mixedOwned = await addAffectedBooking(ownedProject, target, ownedReplacement, "2042-01-03");
    const mixedForeign = await addAffectedBooking(foreignProject, target, foreignReplacement, "2042-01-03");
    const ownerlessBooking = await addAffectedBooking(unownedProject, target, unownedReplacement, "2042-01-04");
    const ownerControlOwned = await addAffectedBooking(ownedProject, target, ownedReplacement, "2042-01-05");
    const ownerControlForeign = await addAffectedBooking(foreignProject, target, foreignReplacement, "2042-01-06");

    const ownedPreview = await call(previewRoute, owningSuper, "2042-01-01");
    const ownedCommit = await call(commitRoute, owningSuper, "2042-01-01");
    const foreignPreview = await call(previewRoute, owningSuper, "2042-01-02");
    const foreignBefore = await snapshot([foreignBooking.id]);
    const foreignCommit = await call(commitRoute, owningSuper, "2042-01-02");
    const foreignAfter = await snapshot([foreignBooking.id]);
    runtime.session = session(owningSuper);
    let directPreviewAction;
    let directCommitAction;
    try {
      await previewAdminUnavailableAction(target.id, "2042-01-02", "2042-01-02");
      directPreviewAction = { outcome: "allowed" };
    } catch (error) {
      directPreviewAction = { outcome: "rejected", error: error.message };
    }
    try {
      await commitAdminUnavailableAction(target.id, "2042-01-02", "2042-01-02");
      directCommitAction = { outcome: "allowed" };
    } catch (error) {
      directCommitAction = { outcome: "rejected", error: error.message };
    }
    const mixedBefore = await snapshot([mixedOwned.id, mixedForeign.id]);
    const mixedPreview = await call(previewRoute, owningSuper, "2042-01-03");
    const mixedCommit = await call(commitRoute, owningSuper, "2042-01-03");
    const mixedAfter = await snapshot([mixedOwned.id, mixedForeign.id]);
    const ownerlessBefore = await snapshot([ownerlessBooking.id]);
    const ownerlessPreview = await call(previewRoute, owningSuper, "2042-01-04");
    const ownerlessCommit = await call(commitRoute, owningSuper, "2042-01-04");
    const ownerlessAfter = await snapshot([ownerlessBooking.id]);
    const ownerPreview = await call(previewRoute, orgOwner, "2042-01-05", "2042-01-06");
    const ownerCommit = await call(commitRoute, orgOwner, "2042-01-05", "2042-01-06");
    const inactivePreview = await call(previewRoute, deactivatedOwner, "2042-01-01");
    const inactiveCommit = await call(commitRoute, deactivatedOwner, "2042-01-01");

    const raceOwned = await addAffectedBooking(ownedProject, target, ownedReplacement, "2042-01-07");
    const raceScope = await checkAdminUnavailableAccess({ id: owningSuper.id, role: "super_admin" }, target.id, "2042-01-07", "2042-01-07");
    const raceForeign = await addAffectedBooking(foreignProject, target, foreignReplacement, "2042-01-07");
    const raceForeignBefore = await snapshot([raceForeign.id]);
    runtime.session = session(owningSuper);
    const raceCommit = await commitAdminUnavailable(target.id, "2042-01-07", "2042-01-07", { id: owningSuper.id, role: "super_admin" });
    const raceForeignAfter = await snapshot([raceForeign.id]);

    const raw = {
      owned: { previewStatus: ownedPreview.status, previewItems: ownedPreview.body.length, commitStatus: ownedCommit.status, commitBody: ownedCommit.body },
      foreign: { previewStatus: foreignPreview.status, commitStatus: foreignCommit.status, unchanged: JSON.stringify(foreignBefore) === JSON.stringify(foreignAfter) },
      directActions: { preview: directPreviewAction, commit: directCommitAction },
      mixed: { previewStatus: mixedPreview.status, commitStatus: mixedCommit.status, unchanged: JSON.stringify(mixedBefore) === JSON.stringify(mixedAfter) },
      ownerless: { previewStatus: ownerlessPreview.status, commitStatus: ownerlessCommit.status, unchanged: JSON.stringify(ownerlessBefore) === JSON.stringify(ownerlessAfter) },
      org_owner_mixed: { previewStatus: ownerPreview.status, previewItems: ownerPreview.body.length, commitStatus: ownerCommit.status, commitBody: ownerCommit.body },
      deactivated_org_owner: { previewStatus: inactivePreview.status, commitStatus: inactiveCommit.status },
      per_booking_guard: { precheckAllowed: raceScope, commitBody: raceCommit, lateForeignUnchanged: JSON.stringify(raceForeignBefore) === JSON.stringify(raceForeignAfter) },
    };
    console.log("RAW admin-unavailable scope matrix:", JSON.stringify(raw));

    assert.equal(ownedPreview.status, 200);
    assert.equal(ownedPreview.body[0].bookingId, ownedBooking.id);
    assert.equal(ownedCommit.status, 200);
    assert.equal(ownedCommit.body.succeeded, 1);
    assert.equal((await db.booking.findUnique({ where: { id: ownedBooking.id } })).adminId, ownedReplacement.id);
    assert.equal(foreignPreview.status, 403);
    assert.equal(foreignCommit.status, 403);
    assert.deepEqual(foreignAfter, foreignBefore);
    assert.deepEqual(directPreviewAction, { outcome: "rejected", error: "Forbidden" });
    assert.deepEqual(directCommitAction, { outcome: "rejected", error: "Forbidden" });
    assert.equal(mixedPreview.status, 403);
    assert.equal(mixedCommit.status, 403);
    assert.deepEqual(mixedAfter, mixedBefore);
    assert.equal(ownerlessPreview.status, 403);
    assert.equal(ownerlessCommit.status, 403);
    assert.deepEqual(ownerlessAfter, ownerlessBefore);
    assert.equal(ownerPreview.status, 200);
    assert.equal(ownerPreview.body.length, 2);
    assert.equal(ownerCommit.status, 200);
    assert.equal(ownerCommit.body.succeeded, 2);
    assert.equal(inactivePreview.status, 401);
    assert.equal(inactiveCommit.status, 401);
    assert.equal(raceScope, true);
    assert.equal(raceCommit.succeeded, 1);
    assert.deepEqual(raceCommit.failed, [{ bookingId: raceForeign.id, reason: "project_not_managed" }]);
    assert.deepEqual(raceForeignAfter, raceForeignBefore);
    assert.equal((await db.booking.findUnique({ where: { id: raceOwned.id } })).adminId, ownedReplacement.id);
  } finally {
    runtime.session = null;
    await db.auditLog.deleteMany({ where: { entityType: "Booking", entityId: { in: bookingIds } } });
    await db.project.deleteMany({ where: { id: { in: projectIds } } });
    await db.admin.deleteMany({ where: { id: { in: adminIds } } });
    await db.$disconnect();
  }
});
