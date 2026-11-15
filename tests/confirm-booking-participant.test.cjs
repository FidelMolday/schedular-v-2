const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
process.env.AZURE_AD_TENANT_ID ??= "9f6e83db-7a61-4c31-a5d8-1df830f649bf";

let currentIp = "127.0.0.1";
require("next/headers").headers = async () => new Headers({ "x-forwarded-for": currentIp });
require("next/cache").revalidatePath = () => {};

const { db } = require("../lib/db.ts");
const { setAdminRangesForDate } = require("../lib/data/availability-ranges.ts");
const { confirmBookingAction } = require("../lib/actions.ts");

process.env.RESEND_API_KEY = "";

test("public booking confirmation binds participant id to both project and submitted email", async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const date = new Date(Date.now() + 4 * 86400000);
  const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const admin = await db.admin.create({ data: { name: "Confirm Test Admin", initials: "CT", email: `confirm-${suffix}@example.test`, role: "admin", accountType: "organizational" } });
  const project = await db.project.create({
    data: {
      slug: `confirm-${suffix}`, name: "Confirm Token Test", company: "Tests", description: "",
      durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
      includeWeekends: true, minNoticeHours: 0, timezone: "UTC", bookingDeadlineDays: 0,
      bufferMinutes: 0, maxSessionsPerAdminPerDay: 10, sessionCapacity: 1,
      status: "active", availabilityLockDate: new Date(Date.now() + 90 * 86400000),
      brandingLogoInitial: "T", brandingPrimaryColor: "#111111", brandingSenderName: "Tests",
      ownerId: admin.id, meetingPlatformPreference: "auto",
    },
  });
  const otherProject = await db.project.create({
    data: {
      slug: `confirm-other-${suffix}`, name: "Other Confirm Project", company: "Tests", description: "",
      durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
      includeWeekends: true, minNoticeHours: 0, timezone: "UTC", bookingDeadlineDays: 0,
      bufferMinutes: 0, maxSessionsPerAdminPerDay: 10, sessionCapacity: 1,
      status: "active", availabilityLockDate: new Date(Date.now() + 90 * 86400000),
      brandingLogoInitial: "T", brandingPrimaryColor: "#111111", brandingSenderName: "Tests",
      ownerId: admin.id, meetingPlatformPreference: "auto",
    },
  });
  try {
    await db.projectAdmin.create({ data: { projectId: project.id, adminId: admin.id } });
    await setAdminRangesForDate(admin.id, dateKey, [{ startTime: "09:00", endTime: "17:00" }]);
    const participant = await db.participant.create({ data: { projectId: project.id, name: "Confirm Participant", email: `participant-${suffix}@example.test` } });
    const base = { projectId: project.id, dateKey, time: "10:00", participantName: participant.name, participantEmail: participant.email, participantId: participant.id };

    currentIp = "127.0.0.31";
    const wrongProject = await confirmBookingAction({ ...base, projectId: otherProject.id });
    assert.deepEqual(wrongProject, { ok: false, reason: "slot_full" });
    currentIp = "127.0.0.32";
    const wrongEmail = await confirmBookingAction({ ...base, participantEmail: `attacker-${suffix}@example.test` });
    assert.deepEqual(wrongEmail, { ok: false, reason: "slot_full" });

    currentIp = "127.0.0.33";
    const confirmed = await confirmBookingAction(base);
    console.log("RAW public confirmation positive:", JSON.stringify({ ok: confirmed.ok, adminName: confirmed.adminName }));
    assert.equal(confirmed.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await db.participant.findUnique({ where: { id: participant.id }, select: { status: true } })).status, "booked");
    console.log("RAW public confirmation negatives:", JSON.stringify({ wrongProject: wrongProject.reason, wrongEmail: wrongEmail.reason }));
  } finally {
    await db.auditLog.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
    await db.booking.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
    await db.projectAdmin.deleteMany({ where: { projectId: { in: [project.id, otherProject.id] } } });
    await db.project.deleteMany({ where: { id: { in: [project.id, otherProject.id] } } });
    await db.admin.deleteMany({ where: { id: admin.id } });
    await db.$disconnect();
  }
});
