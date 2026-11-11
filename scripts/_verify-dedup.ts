import "dotenv/config";
import { PrismaClient, EmailCategory, EmailAudience } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createBooking } from "../lib/data/bookings.ts";

const urlOverride = process.argv[2];
if (urlOverride) process.env.DATABASE_URL = urlOverride;
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const db = new PrismaClient({ adapter });

const PROJECT_ID = "bt-notify-dedup-test";
const OWNER_ADMIN_ID = "a0";
const ADMIN_B_ID = "cmswyu0tp000031h7z8yrzg17";
const TEST_DATE = "2026-09-15";

const ownerEmail = "owner@example.test";
const adminBEmail = "caleb@careerconnectionsltd.com";
const participantDistinctEmail = "calebmwebi@gmail.com";

async function main() {
  console.log("=== SCRATCH DEDUP VERIFICATION ===");
  console.log("DATABASE:", (process.env.DATABASE_URL || "").split("@")[1]?.split("?")[0] ?? process.env.DATABASE_URL);
  console.log("RESEND_API_KEY present:", (process.env.RESEND_API_KEY ?? "").length > 0);
  console.log();

  // --- 1. Create scratch test project (owner = personal account → provisioning short-circuits) ---
  console.log("[setup] Creating test project...");
  const project = await db.project.upsert({
    where: { id: PROJECT_ID },
    update: {},
    create: {
      id: PROJECT_ID,
      slug: "bt-notify-dedup",
      name: "BT Notify Dedup Test",
      company: "Scratch Test",
      description: "Scratch project to verify same-address notification dedup.",
      durationMinutes: 30,
      availabilityPeriodDays: 30,
      dailyStart: "09:00",
      dailyEnd: "17:00",
      includeWeekends: false,
      minNoticeHours: 0,
      timezone: "Africa/Nairobi",
      bookingDeadlineDays: 30,
      bufferMinutes: 0,
      maxSessionsPerAdminPerDay: 5,
      sessionCapacity: 10,
      maxBookingsPerParticipant: null,
      autoCompleteBookings: false,
      selfServiceWindowHours: 4,
      status: "active",
      availabilityLockDate: new Date(),
      brandingLogoInitial: "BT",
      brandingPrimaryColor: "#000",
      brandingSenderName: "Scratch Test",
      ownerId: OWNER_ADMIN_ID,
      meetingPlatformPreference: "teams",
      assignmentMode: "PARTICIPANT_CHOICE",
    },
  });
  console.log("[setup] Project:", project.id, "owner:", project.ownerId);

  // --- 2. Create project-scoped active templates (booking_confirmation x 3 audiences) ---
  console.log("[setup] Creating project-scoped templates...");
  for (const audience of ["participant", "admin", "super_admin"] as const) {
    const existing = await db.emailTemplate.findFirst({
      where: { projectId: PROJECT_ID, category: "booking_confirmation", audience, isActive: true },
    });
    if (!existing) {
      await db.emailTemplate.create({
        data: {
          projectId: PROJECT_ID,
          category: "booking_confirmation",
          audience,
          subject: `Dedup Test: {{participant_name}} booked {{project_name}} (${audience})`,
          bodyHtml: `<p>Dedup verification for ${audience}. Participant: {{participant_name}}, Date: {{session_date}}, Time: {{session_time}}.</p>`,
          version: 1,
          isActive: true,
        },
      });
    }
  }
  console.log("[setup] Templates ensured.");

  // --- 3. Add projectAdmin assignments ---
  console.log("[setup] Adding projectAdmin assignments...");
  for (const adminId of [OWNER_ADMIN_ID, ADMIN_B_ID]) {
    await db.projectAdmin.upsert({
      where: { projectId_adminId: { projectId: PROJECT_ID, adminId } },
      update: {},
      create: { projectId: PROJECT_ID, adminId },
    });
  }
  console.log("[setup] Admins assigned:", OWNER_ADMIN_ID, ADMIN_B_ID);

  // --- 4. Create availability ranges ---
  console.log("[setup] Creating availability ranges for", TEST_DATE, "09:00-17:00...");
  for (const adminId of [OWNER_ADMIN_ID, ADMIN_B_ID]) {
    await db.adminAvailabilityRange.upsert({
      where: { id: `dedup-range-${adminId}` },
      update: {},
      create: {
        id: `dedup-range-${adminId}`,
        adminId,
        dateKey: TEST_DATE,
        startTime: "09:00",
        endTime: "17:00",
      },
    });
  }
  console.log("[setup] Ranges created.");

  // =========================================================================
  // TEST A: Same-address scenario — participant=admin=owner, all same email
  // =========================================================================
  console.log("\n========================================================================");
  console.log("TEST A: SAME-ADDRESS (participant = admin = owner = owner@example.test)");
  console.log("Expected after fix: 2 NotificationLog rows (1 per round × 1 deduped recipient)");
  console.log("Before fix: 4 rows (2 per round × 2 same-email recipients)");
  console.log("========================================================================\n");

  const resultA = await createBooking({
    projectId: PROJECT_ID,
    dateKey: TEST_DATE,
    time: "10:00",
    participantName: "Same-Address Dedup Test",
    participantEmail: ownerEmail,
    adminId: OWNER_ADMIN_ID,
  });
  console.log("[test-a] createBooking result:", JSON.stringify(resultA, null, 2));

  if (!resultA.ok) {
    console.error("[test-a] BOOKING FAILED:", resultA.reason);
  } else {
    const bookingId = resultA.booking.id;
    console.log("[test-a] Booking ID:", bookingId);
    console.log("[test-a] Assigned admin:", resultA.admin.id, resultA.admin.name);

    // Wait a moment for any async work to settle
    await new Promise((r) => setTimeout(r, 3000));

    const logsA = await db.notificationLog.findMany({
      where: { projectId: PROJECT_ID, category: "booking_confirmation" },
      orderBy: { createdAt: "asc" },
      select: { id: true, recipientEmail: true, recipientRole: true, status: true, subject: true, createdAt: true },
    });
    console.log(`[test-a] NotificationLog rows (${logsA.length}):`);
    for (const log of logsA) {
      console.log(`  ${log.createdAt.toISOString()} | ${log.recipientEmail} | ${log.recipientRole} | ${log.status} | ${log.subject.slice(0, 60)}`);
    }

    if (logsA.length === 2 && logsA.every((l) => l.recipientEmail === ownerEmail && l.status === "sent")) {
      console.log("[test-a] ✅ PASS — exactly 2 rows (1/round), all sent to shared address");
    } else if (logsA.length === 4) {
      console.log("[test-a] ❌ FAIL — 4 rows means dedup did NOT collapse (pre-fix behavior)");
    } else {
      console.log(`[test-a] ⚠️  UNEXPECTED — ${logsA.length} rows (expected 2)`);
    }
  }

  // =========================================================================
  // TEST B: Distinct-address — all three recipients different emails
  // =========================================================================
  console.log("\n========================================================================");
  console.log("TEST B: DISTINCT-ADDRESS (participant ≠ admin ≠ owner)");
  console.log("  participant:", participantDistinctEmail);
  console.log("  admin:", adminBEmail, "(super_admin role)");
  console.log("  owner:", ownerEmail, "(org_owner → super_admin role)");
  console.log("Expected after fix: 6 rows (2 rounds × 3 distinct recipients)");
  console.log("========================================================================\n");

  const resultB = await createBooking({
    projectId: PROJECT_ID,
    dateKey: TEST_DATE,
    time: "11:00",
    participantName: "Distinct-Address Regression Test",
    participantEmail: participantDistinctEmail,
    adminId: ADMIN_B_ID,
  });
  console.log("[test-b] createBooking result:", JSON.stringify(resultB, null, 2));

  if (!resultB.ok) {
    console.error("[test-b] BOOKING FAILED:", resultB.reason);
  } else {
    const bookingId = resultB.booking.id;
    console.log("[test-b] Booking ID:", bookingId);
    console.log("[test-b] Assigned admin:", resultB.admin.id, resultB.admin.name);

    await new Promise((r) => setTimeout(r, 3000));

    const logsB = await db.notificationLog.findMany({
      where: { projectId: PROJECT_ID, category: "booking_confirmation", createdAt: { gt: new Date(Date.now() - 120_000) } },
      orderBy: { createdAt: "asc" },
      select: { id: true, recipientEmail: true, recipientRole: true, status: true, subject: true, createdAt: true },
    });
    console.log(`[test-b] NotificationLog rows (${logsB.length}):`);
    for (const log of logsB) {
      console.log(`  ${log.createdAt.toISOString()} | ${log.recipientEmail} | ${log.recipientRole} | ${log.status} | ${log.subject.slice(0, 60)}`);
    }

    const emails = new Set(logsB.filter((l) => l.status === "sent").map((l) => l.recipientEmail));
    if (logsB.length === 6 && emails.size === 3) {
      console.log("[test-b] ✅ PASS — 6 rows (2 rounds × 3 distinct), all sent");
    } else {
      console.log(`[test-b] ⚠️  CHECK — ${logsB.length} rows, ${emails.size} unique emails (expected 6 rows, 3 emails)`);
    }
  }

  // --- Summary ---
  console.log("\n=== SUMMARY ===");
  const allLogs = await db.notificationLog.findMany({
    where: { projectId: PROJECT_ID, category: "booking_confirmation" },
    orderBy: { createdAt: "asc" },
    select: { id: true, recipientEmail: true, recipientRole: true, status: true, createdAt: true },
  });
  console.log(`Total booking_confirmation rows: ${allLogs.length}`);
  for (const log of allLogs) {
    console.log(`  ${log.recipientEmail} | ${log.recipientRole} | ${log.status}`);
  }
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); await pool.end(); });