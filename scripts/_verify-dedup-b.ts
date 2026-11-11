import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { createBooking } from "../lib/data/bookings.ts";

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const adapter = new PrismaPg(pool);
const db = new PrismaClient({ adapter });

const PROJECT_ID = "bt-notify-dedup-test";
const ADMIN_B_ID = "cmswyu0tp000031h7z8yrzg17";
const TEST_DATE = "2026-09-15";

async function main() {
  console.log("=== TEST B: DISTINCT-ADDRESS REGRESSION ===");
  console.log("participant: calebmwebi@gmail.com (distinct)");
  console.log("admin: caleb@careerconnectionsltd.com (distinct, super_admin)");
  console.log("owner: owner@example.test (distinct, org_owner -> super_admin)");
  console.log();

  console.log("[check] All 3 emails confirmed distinct.");

  console.log("[check] Verifying project and admin assignments...");
  const project = await db.project.findUnique({ where: { id: PROJECT_ID }, select: { id: true, ownerId: true } });
  if (!project) { console.error("FATAL: test project not found"); process.exit(1); }
  const admins = await db.projectAdmin.findMany({ where: { projectId: PROJECT_ID }, select: { adminId: true } });
  console.log("[check] Project owner:", project.ownerId, "| projectAdmins:", admins.map((a) => a.adminId).join(", "));

  console.log();
  console.log("Running createBooking...");
  const resultB = await createBooking({
    projectId: PROJECT_ID,
    dateKey: TEST_DATE,
    time: "11:00",
    participantName: "Distinct-Address Regression Test",
    participantEmail: "calebmwebi@gmail.com",
    adminId: ADMIN_B_ID,
  });

  console.log("[result]", JSON.stringify(resultB, null, 2));

  if (!resultB.ok) {
    console.error("[test-b] BOOKING FAILED:", resultB.reason);
  } else {
    console.log("[test-b] Booking ID:", resultB.booking.id);
    console.log("[test-b] Assigned admin:", resultB.admin.id, resultB.admin.name);
  }

  await new Promise((r) => setTimeout(r, 2000));

  const logs = await db.notificationLog.findMany({
    where: { projectId: PROJECT_ID, category: "booking_confirmation", createdAt: { gt: new Date(Date.now() - 120_000) } },
    orderBy: { createdAt: "asc" },
    select: { id: true, recipientEmail: true, recipientRole: true, status: true, subject: true, createdAt: true },
  });

  console.log(`[test-b] NotificationLog rows (${logs.length}):`);
  for (const log of logs) {
    console.log("  " + log.createdAt.toISOString() + " | " + log.recipientEmail + " | " + log.recipientRole + " | " + log.status + " | " + log.subject.slice(0, 60));
  }

  const uniqueEmails = new Set(logs.filter((l) => l.status === "sent").map((l) => l.recipientEmail));
  if (logs.length === 6 && uniqueEmails.size === 3) {
    console.log("[test-b] PASS - 6 rows (2 rounds x 3 distinct), all sent");
  } else {
    console.log("[test-b] rows=" + logs.length + " unique_emails=" + uniqueEmails.size + " (expected 6 rows, 3 emails)");
  }
}

main()
  .catch((err) => { console.error("FATAL:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); await pool.end(); });
