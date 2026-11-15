const assert = require("node:assert/strict");
const { createHmac, randomUUID } = require("node:crypto");
const { test } = require("node:test");
process.env.AZURE_AD_TENANT_ID ??= "9f6e83db-7a61-4c31-a5d8-1df830f649bf";

let currentIp = "127.0.0.1";
require("next/headers").headers = async () => new Headers({ "x-forwarded-for": currentIp });
const authPath = require.resolve("../auth.ts");
require(authPath);
require.cache[authPath].exports = { auth: async () => null };

const { db } = require("../lib/db.ts");
const { setAdminRangesForDate } = require("../lib/data/availability-ranges.ts");
const { createBooking } = require("../lib/data/bookings.ts");
const { createVerificationPin } = require("../lib/pin.ts");
const { signManageAdminToken, verifyManageToken } = require("../lib/manage-token.ts");
const { participantCancelAction, participantRescheduleAction, verifyManagePin } = require("../app/manage/[bookingId]/actions.ts");

process.env.AUTH_SECRET = "manage-actions-scratch-test-secret";
process.env.RESEND_API_KEY = "";

function expiredManageToken(bookingId, email) {
  const payload = `${bookingId}|${email.toLowerCase()}|${Math.floor(Date.now() / 1000) - 60}`;
  const signature = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

async function makeBooking(projectId, dateKey, time, email) {
  const result = await createBooking({ projectId, dateKey, time, participantName: "Manage Test Participant", participantEmail: email });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.booking;
}

test("participant manage mutations require a matching live participant token and support PIN-to-cancel/reschedule", async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const tomorrow = new Date(Date.now() + 4 * 86400000);
  const key = (offset) => {
    const d = new Date(tomorrow.getTime() + offset * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  const admin = await db.admin.create({ data: { name: "Manage Test Admin", initials: "MT", email: `manage-${suffix}@example.test`, role: "admin", accountType: "organizational" } });
  const project = await db.project.create({
    data: {
      slug: `manage-${suffix}`, name: "Manage Token Test", company: "Tests", description: "",
      durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
      includeWeekends: true, minNoticeHours: 0, timezone: "UTC", bookingDeadlineDays: 0,
      bufferMinutes: 0, maxSessionsPerAdminPerDay: 10, sessionCapacity: 1,
      status: "active", availabilityLockDate: new Date(Date.now() + 90 * 86400000),
      brandingLogoInitial: "T", brandingPrimaryColor: "#111111", brandingSenderName: "Tests",
      ownerId: admin.id, meetingPlatformPreference: "auto", selfServiceWindowHours: 4,
    },
  });
  const email = `participant-${suffix}@example.test`;
  let bookingToCancel;
  let bookingToReschedule;
  try {
    await db.projectAdmin.create({ data: { projectId: project.id, adminId: admin.id } });
    for (let offset = 0; offset <= 4; offset++) {
      await setAdminRangesForDate(admin.id, key(offset), [{ startTime: "09:00", endTime: "17:00" }]);
    }
    bookingToCancel = await makeBooking(project.id, key(0), "10:00", email);
    const otherBooking = await makeBooking(project.id, key(0), "12:00", email);
    bookingToReschedule = await makeBooking(project.id, key(1), "10:00", email);

    const reject = async (ip, run) => {
      currentIp = ip;
      await assert.rejects(run(), /Unauthorized|Forbidden/);
    };
    await reject("127.0.0.11", () => participantCancelAction(bookingToCancel.id));
    await reject("127.0.0.12", () => participantCancelAction(bookingToCancel.id, "malformed"));
    await reject("127.0.0.13", () => participantCancelAction(bookingToCancel.id, expiredManageToken(bookingToCancel.id, email)));
    const { signManageToken } = require("../lib/manage-token.ts");
    await reject("127.0.0.14", () => participantCancelAction(bookingToCancel.id, signManageToken(otherBooking.id, email)));
    await reject("127.0.0.15", () => participantCancelAction(bookingToCancel.id, signManageAdminToken(bookingToCancel.id, `unassigned-${suffix}@example.test`)));

    currentIp = "127.0.0.21";
    const cancelPin = await createVerificationPin(bookingToCancel.id, email);
    const cancelVerified = await verifyManagePin(bookingToCancel.id, email, cancelPin.pin);
    console.log("RAW PIN-to-cancel verification:", JSON.stringify({ verified: cancelVerified.verified, tokenPresent: !!cancelVerified.token }));
    assert.equal(cancelVerified.verified, true);
    await participantCancelAction(bookingToCancel.id, cancelVerified.token);
    assert.equal((await db.booking.findUnique({ where: { id: bookingToCancel.id }, select: { status: true } })).status, "cancelled");

    currentIp = "127.0.0.22";
    const reschedulePin = await createVerificationPin(bookingToReschedule.id, email);
    const rescheduleVerified = await verifyManagePin(bookingToReschedule.id, email, reschedulePin.pin);
    assert.equal(rescheduleVerified.verified, true);
    const result = await participantRescheduleAction(bookingToReschedule.id, key(2), "11:00", rescheduleVerified.token);
    console.log("RAW PIN-to-reschedule result:", JSON.stringify({ ok: result.ok, newBookingId: result.newBookingId, tokenPresent: !!result.token }));
    assert.equal(result.ok, true);
    assert.equal(verifyManageToken(result.token).bookingId, result.newBookingId);
  } finally {
    await db.verificationPin.deleteMany({ where: { bookingId: { in: [bookingToCancel?.id, bookingToReschedule?.id].filter(Boolean) } } });
    await db.auditLog.deleteMany({ where: { projectId: project.id } });
    await db.booking.deleteMany({ where: { projectId: project.id } });
    await db.projectAdmin.deleteMany({ where: { projectId: project.id } });
    await db.project.deleteMany({ where: { id: project.id } });
    await db.admin.deleteMany({ where: { id: admin.id } });
    await db.$disconnect();
  }
});
