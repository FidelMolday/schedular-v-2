const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { db } = require("../lib/db.ts");
const { setAdminRangesForDate } = require("../lib/data/availability-ranges.ts");
const { claimWaitlistOffer, offerNextWaitlistEntry } = require("../lib/data/waitlist.ts");
const { signWaitlistClaimToken, verifyWaitlistClaimToken } = require("../lib/waitlist-claim-token.ts");

process.env.AUTH_SECRET = "waitlist-claim-scratch-test-secret";
process.env.RESEND_API_KEY = "";

test("a valid waitlist offer token claims a slot once; stale and replayed claims fail", async () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const date = new Date(Date.now() + 3 * 86400000);
  const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const admin = await db.admin.create({
    data: { name: "Waitlist Test Admin", initials: "WT", email: `waitlist-${suffix}@example.test`, role: "admin", accountType: "organizational" },
  });
  const project = await db.project.create({
    data: {
      slug: `waitlist-${suffix}`, name: "Waitlist Token Test", company: "Tests", description: "",
      durationMinutes: 30, availabilityPeriodDays: 30, dailyStart: "09:00", dailyEnd: "17:00",
      includeWeekends: true, minNoticeHours: 0, timezone: "UTC", bookingDeadlineDays: 0,
      bufferMinutes: 0, maxSessionsPerAdminPerDay: 10, sessionCapacity: 1,
      status: "active", availabilityLockDate: new Date(Date.now() + 90 * 86400000),
      brandingLogoInitial: "T", brandingPrimaryColor: "#111111", brandingSenderName: "Tests",
      ownerId: admin.id, meetingPlatformPreference: "auto",
    },
  });
  let entry;
  let linkEntry;
  let offerTemplate;
  try {
    offerTemplate = await db.emailTemplate.create({
      data: {
        category: "waitlist_offer",
        audience: "participant",
        projectId: project.id,
        subject: "A slot is available",
        bodyHtml: '<p>Hello {{participant_name}}, <a href="{{booking_link}}">claim your slot</a>.</p>',
      },
    });
    await db.projectAdmin.create({ data: { projectId: project.id, adminId: admin.id } });
    await setAdminRangesForDate(admin.id, dateKey, [{ startTime: "09:00", endTime: "17:00" }]);
    const linkDate = new Date(date.getTime() + 1 * 86400000);
    const linkDateKey = `${linkDate.getUTCFullYear()}-${String(linkDate.getUTCMonth() + 1).padStart(2, "0")}-${String(linkDate.getUTCDate()).padStart(2, "0")}`;
    linkEntry = await db.waitlistEntry.create({
      data: { projectId: project.id, name: "Offer Link Participant", email: `link-${suffix}@example.test`, status: "waiting" },
    });
    await offerNextWaitlistEntry(project.id, linkDateKey, "13:00");
    const linkLog = await db.notificationLog.findFirst({
      where: { projectId: project.id, category: "waitlist_offer", recipientEmail: linkEntry.email },
      orderBy: { createdAt: "desc" },
      select: { renderedBody: true },
    });
    assert.match(linkLog.renderedBody, new RegExp(`/waitlist/claim/${linkEntry.id}\\?token=`));
    const tokenMatch = linkLog.renderedBody.match(new RegExp(`/waitlist/claim/${linkEntry.id}\\?token=([^&" ]+)`));
    assert.ok(tokenMatch);
    assert.equal(verifyWaitlistClaimToken(decodeURIComponent(tokenMatch[1]))?.entryId, linkEntry.id);
    console.log("RAW waitlist offer link:", JSON.stringify({ signedTokenPresent: true, entryBound: true }));

    const expiresAt = new Date(Date.now() + 60_000);
    entry = await db.waitlistEntry.create({
      data: {
        projectId: project.id, name: "Waitlist Participant", email: `participant-${suffix}@example.test`,
        dateKey, time: "10:00", status: "offered", offeredAt: new Date(), expiresAt,
      },
    });
    const token = signWaitlistClaimToken(entry.id, expiresAt);
    const claims = verifyWaitlistClaimToken(token);
    assert.equal(claims.entryId, entry.id);

    const wrongEntry = await claimWaitlistOffer(entry.id, expiresAt.getTime() + 1);
    assert.deepEqual(wrongEntry, { ok: false, reason: "offer_expired" });

    const first = await claimWaitlistOffer(entry.id, claims.expiresAtMs);
    console.log("RAW first waitlist claim:", JSON.stringify(first));
    assert.equal(first.ok, true);

    const second = await claimWaitlistOffer(entry.id, claims.expiresAtMs);
    console.log("RAW replayed waitlist claim:", JSON.stringify(second));
    assert.deepEqual(second, { ok: false, reason: "offer_expired" });

    const saved = await db.waitlistEntry.findUnique({ where: { id: entry.id }, select: { status: true, claimedBookingId: true } });
    assert.equal(saved.status, "claimed");
    assert.equal(saved.claimedBookingId, first.booking.id);
  } finally {
    if (entry) await db.waitlistEntry.deleteMany({ where: { id: entry.id } });
    if (linkEntry) await db.waitlistEntry.deleteMany({ where: { id: linkEntry.id } });
    await db.auditLog.deleteMany({ where: { projectId: project.id } });
    await db.booking.deleteMany({ where: { projectId: project.id } });
    if (offerTemplate) await db.emailTemplate.deleteMany({ where: { id: offerTemplate.id } });
    await db.projectAdmin.deleteMany({ where: { projectId: project.id } });
    await db.project.deleteMany({ where: { id: project.id } });
    await db.admin.deleteMany({ where: { id: admin.id } });
    await db.$disconnect();
  }
});
