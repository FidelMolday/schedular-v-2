import { db, isSerializationConflict } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import { offerNextWaitlistEntry, rescindOffersForSlot } from "@/lib/data/waitlist";
import { getActiveTemplate, getActiveTemplateByAudience, renderTemplate } from "@/lib/data/templates";
import { logNotification } from "@/lib/data/notifications";
import { provisionMeeting, removeMeeting, updateMeetingTime } from "@/lib/data/meetings";
import { isAdminAvailableForSlot } from "@/lib/data/availability-ranges";
import { isAdminCertifiedForProject } from "@/lib/data/certifications";
import { timesOverlap } from "@/lib/timeOverlap";
import { hoursUntilSession } from "@/lib/slotHelpers";
import { signManageAdminToken } from "@/lib/manage-token";
import { demoRecipientEmail, isDemoProjectId } from "@/lib/demo";
import { Resend } from "resend";
import { stripHtml } from "@/lib/html-to-text";
import type { EmailAudience, Prisma } from "@prisma/client";

const LOCK_ATTEMPTS = 20;
const LOCK_BACKOFF_MS = 50;

// Bounded non-blocking advisory-lock acquire. The old `pg_advisory_xact_lock`
// parked a pooled connection for every writer queued behind the slot lock, so a
// burst larger than the pool starved it and every excess caller failed with
// P2028. `pg_try_advisory_xact_lock` never blocks: per attempt the hold is a
// single fast query, and the retry loop keeps "queue and eventually win"
// semantics for the common case (a competitor's transaction is short), then
// fails fast with slot_full instead of holding a connection for an unbounded
// wait. The lock is xact-scoped either way, so release-at-commit semantics and
// the exactly-one-writer guarantee are unchanged.
async function acquireAdvisoryLock(tx: Prisma.TransactionClient, key: string): Promise<boolean> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const rows = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`;
    if (rows[0]?.acquired) return true;
    if (attempt < LOCK_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, LOCK_BACKOFF_MS));
    }
  }
  return false;
}

/**
 * Cross-project conflict check: returns true if the admin already has a
 * confirmed booking on this dateKey/time that overlaps with the proposed
 * slot, across ALL projects (not just the current one).
 *
 * Each existing booking's own project duration+buffer is used for the
 * overlap window — not the new project's rules.
 */
export async function hasSchedulingConflict(
  adminId: string,
  dateKey: string,
  time: string,
  newDurationMinutes: number,
  newBufferMinutes: number,
  excludeBookingId?: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> {
  const client = tx ?? db;

  const existingBookings = await client.booking.findMany({
    where: {
      adminId,
      dateKey,
      status: "confirmed",
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: {
      time: true,
      project: { select: { durationMinutes: true, bufferMinutes: true } },
    },
  });

  for (const b of existingBookings) {
    const existingWindow = b.project.durationMinutes + b.project.bufferMinutes;
    const newWindow = newDurationMinutes + newBufferMinutes;
    if (timesOverlap(time, newWindow, b.time, existingWindow)) {
      return true;
    }
  }

  return false;
}

type AdminInfo = { id: string; name: string; initials: string };

const NOTIFICATION_FROM = process.env.EMAIL_FROM ?? "Scheduler <notifications@eureka-ent.org>";

type BookingNotificationInput = {
  id: string;
  projectId: string;
  participantName: string;
  participantEmail: string;
  dateKey: string;
  time: string;
  adminId: string;
};

type BookingNotificationCategory = "booking_confirmation" | "cancellation_notice" | "reschedule_notice";

function recipientRoleFor(admin: { role: string }): EmailAudience {
  return admin.role === "admin" ? "admin" : "super_admin";
}

/**
 * Sends a booking-related notification to the participant, the assigned admin,
 * and the project owner. The participant always receives it; the assigned
 * admin always receives it (they run the session); the project owner receives
 * it only when their own notifyOnBooking preference is enabled, and never as a
 * separate copy when they are also the assigned admin.
 *
 * Sends a real email via Resend and writes one NotificationLog row per
 * recipient with the actual recipientEmail/recipientRole. Send failures are
 * logged with status "failed" and never throw into the booking transaction.
 */
async function sendNotification(
  category: BookingNotificationCategory,
  booking: BookingNotificationInput,
  extraCtx?: Record<string, string>,
) {
  console.log(`[notify] ENTRY category=${category} bookingId=${booking.id} projectId=${booking.projectId}`);
  try {
    const [project, admin] = await Promise.all([
      db.project.findUnique({
        where: { id: booking.projectId },
        select: { id: true, slug: true, name: true, company: true, timezone: true, ownerId: true, meetingPlatformPreference: true },
      }),
      db.admin.findUnique({
        where: { id: booking.adminId },
        select: { id: true, name: true, email: true, role: true },
      }),
    ]);
    if (!project) { console.log(`[notify] ABORT project not found for projectId=${booking.projectId}`); return; }

    const template = await getActiveTemplate(category, booking.projectId);
    console.log(`[notify] template=${template?.id ?? "NULL"} category=${category} projectId=${booking.projectId}`);
    if (!template) { console.log(`[notify] ABORT no active template for category=${category} projectId=${booking.projectId}`); return; }

    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

    // Resolve session-type classification for conditional template blocks.
    let isFeedback = false;
    let meetingPlatformLabel = "";
    let zoomAccountLabel = "";
    let zoomAccountEmail = "";
    let hasZoomAccount = false;
    try {
      const bookingRecord = await db.booking.findUnique({
        where: { id: booking.id },
        select: {
          sessionType: { select: { classification: true } },
          meetingPlatform: true,
          zoomAccountId: true,
          zoomAccount: { select: { label: true, zoomEmail: true } },
        },
      });
      isFeedback = bookingRecord?.sessionType?.classification === "FEEDBACK";
      const platform = bookingRecord?.meetingPlatform
        ?? (project?.meetingPlatformPreference !== "auto" ? project?.meetingPlatformPreference : null);
      if (platform === "zoom" || platform === "teams") {
        meetingPlatformLabel = platform === "zoom" ? "Zoom" : "Microsoft Teams";
      } else if (bookingRecord?.zoomAccountId) {
        meetingPlatformLabel = "Zoom";
      } else {
        meetingPlatformLabel = "Microsoft Teams";
      }
      if (bookingRecord?.zoomAccount) {
        hasZoomAccount = true;
        zoomAccountLabel = bookingRecord.zoomAccount.label;
        zoomAccountEmail = bookingRecord.zoomAccount.zoomEmail;
      }
    } catch {}

    const isDemo = isDemoProjectId(project.id);

    const baseCtx: Record<string, string> = {
      participant_name: booking.participantName,
      participant_email: booking.participantEmail,
      project_name: project.name ?? "",
      company_name: project.company ?? "",
      session_date: booking.dateKey,
      session_time: booking.time,
      admin_name: admin?.name ?? "",
      time_zone: project.timezone ?? "",
      meeting_link: `${baseUrl}/manage/${booking.id}`,
      booking_link: isDemo
        ? `${baseUrl}/book/${project.slug}`
        : `${baseUrl}/book/${booking.projectId}`,
      company_logo: "",
      is_feedback: isFeedback ? "true" : "",
      meeting_platform_label: meetingPlatformLabel,
      has_meeting_link: "",
      no_meeting_link: "true",
      zoom_account_label: zoomAccountLabel,
      zoom_account_email: zoomAccountEmail,
      has_zoom_account: hasZoomAccount ? "true" : "",
      no_zoom_account: hasZoomAccount ? "" : "true",
      ...extraCtx,
    };

    // Set has_meeting_link if the meeting_link override is an actual URL
    if (extraCtx?.meeting_link && (extraCtx.meeting_link.startsWith("http://") || extraCtx.meeting_link.startsWith("https://"))) {
      baseCtx.has_meeting_link = "true";
      baseCtx.no_meeting_link = "";
    }

    type Recipient = { email: string; role: EmailAudience; adminLink?: boolean };
    const recipients: Recipient[] = [
      { email: isDemo ? demoRecipientEmail("participant", booking.participantEmail) : booking.participantEmail, role: "participant" },
    ];

    if (admin?.email) {
      recipients.push({ email: admin.email, role: recipientRoleFor(admin), adminLink: true });
    }
    if (project.ownerId) {
      const owner = await db.admin.findUnique({
        where: { id: project.ownerId },
        select: { id: true, email: true, role: true, notifyOnBooking: true },
      });
      if (owner?.email && owner.notifyOnBooking && owner.id !== admin?.id) {
        recipients.push({ email: owner.email, role: recipientRoleFor(owner), adminLink: true });
      }
    }

    // Dedupe by email: when multiple roles resolve to the same address,
    // keep the highest-privilege role (super_admin > admin > participant)
    // to avoid firing multiple Resend calls to the same inbox in rapid
    // succession, which can cause silent drops by the email provider.
    const ROLE_PRIORITY: Record<EmailAudience, number> = { super_admin: 3, admin: 2, participant: 1 };
    const seenByemail = new Map<string, Recipient>();
    for (const r of recipients) {
      const key = r.email.toLowerCase();
      const existing = seenByemail.get(key);
      if (!existing || ROLE_PRIORITY[r.role] > ROLE_PRIORITY[existing.role]) {
        seenByemail.set(key, { ...r, adminLink: r.adminLink || existing?.adminLink });
      } else if (existing) {
        existing.adminLink = existing.adminLink || r.adminLink;
      }
    }
    const dedupedRecipients = [...seenByemail.values()];

    console.log(`[notify] recipients=${JSON.stringify(dedupedRecipients.map(r => ({ email: r.email, role: r.role, adminLink: !!r.adminLink })))}`);

    const resendApiKey = process.env.RESEND_API_KEY ?? "";
    console.log(`[notify] RESEND_API_KEY present=${resendApiKey.length > 0} length=${resendApiKey.length}`);
    const resend = new Resend(resendApiKey);

    for (const recipient of dedupedRecipients) {
      const ctx = { ...baseCtx };
      if (recipient.adminLink) {
        if (recipient.role === "admin" || recipient.role === "super_admin") {
          const adminToken = signManageAdminToken(booking.id, recipient.email);
          ctx.manage_booking_link = `${baseUrl}/manage/${booking.id}?token=${encodeURIComponent(adminToken)}`;
        } else {
          ctx.manage_booking_link = `${baseUrl}/admin/calendar`;
        }
      }
      // For booking_confirmation, select template by audience; other categories use the single template.
      // Template lookup is inside the per-recipient try/catch so one recipient's
      // missing template doesn't abort sends to the remaining recipients.
      let rendered: { subject: string; bodyHtml: string } | null = null;
      console.log(`[notify] SENDING to=${recipient.email} role=${recipient.role}`);
      try {
        const recipientTemplate = category === "booking_confirmation"
          ? await getActiveTemplateByAudience(category, recipient.role, booking.projectId)
          : template;
        rendered = renderTemplate(recipientTemplate, ctx);
        const result = await resend.emails.send({
          from: NOTIFICATION_FROM,
          to: recipient.email,
          subject: rendered.subject,
          html: rendered.bodyHtml,
          text: stripHtml(rendered.bodyHtml),
        });
        if (result.error || !result.data?.id) {
          throw new Error(result.error?.message ?? "Resend did not return an email id");
        }
        console.log(`[notify] SENT to=${recipient.email} resendId=${result.data.id}`);
        await logNotification({
          templateId: template.id,
          category,
          projectId: booking.projectId,
          recipientEmail: recipient.email,
          recipientRole: recipient.role,
          subject: rendered.subject,
          renderedBody: rendered.bodyHtml,
          status: "sent",
        });
        console.log(`[notify] LOGGED to=${recipient.email} status=sent`);
      } catch (err) {
        console.error(`[notify] SEND_FAILED to=${recipient.email} role=${recipient.role}:`, err);
        await logNotification({
          templateId: template.id,
          category,
          projectId: booking.projectId,
          recipientEmail: recipient.email,
          recipientRole: recipient.role,
          subject: rendered?.subject ?? `Notification (${category})`,
          renderedBody: rendered?.bodyHtml ?? `<p>Notification delivery failed</p>`,
          status: "failed",
        }).catch((logErr) => console.error(`[notify] LOG_FAILED to=${recipient.email}:`, logErr));
      }
    }
    console.log(`[notify] DONE category=${category} bookingId=${booking.id}`);
  } catch (err) {
    console.error(`[notify] OUTER_CATCH category=${category} bookingId=${booking.id}:`, err);
  }
}

export async function getEligibleAdmins(
  projectId: string,
  dateKey: string,
  time: string,
  tx?: Prisma.TransactionClient
): Promise<string[]> {
  const client = tx ?? db;

  const project = await client.project.findUnique({
    where: { id: projectId },
    select: {
      durationMinutes: true,
      bufferMinutes: true,
      maxSessionsPerAdminPerDay: true,
    },
  });
  if (!project) return [];

  const projectAdminRows = await client.projectAdmin.findMany({
    where: { projectId, admin: { isActive: true } },
    select: { adminId: true },
  });
  const candidateIds = projectAdminRows.map((pa) => pa.adminId);
  if (candidateIds.length === 0) return [];

  const certifiedIds: string[] = [];
  for (const adminId of candidateIds) {
    if (await isAdminCertifiedForProject(projectId, adminId, client)) {
      certifiedIds.push(adminId);
    }
  }
  if (certifiedIds.length === 0) return [];

  const rangeAvailable: string[] = [];
  for (const adminId of certifiedIds) {
    const available = await isAdminAvailableForSlot(
      adminId,
      dateKey,
      time,
      project.durationMinutes
    );
    if (available) rangeAvailable.push(adminId);
  }
  if (rangeAvailable.length === 0) return [];

  const bookingsToday = await client.booking.findMany({
    where: {
      projectId,
      dateKey,
      adminId: { in: rangeAvailable },
      status: "confirmed",
    },
    select: { adminId: true },
  });

  const adminDayCounts: Record<string, number> = {};
  const blockedAdmins = new Set<string>();
  for (const b of bookingsToday) {
    adminDayCounts[b.adminId] = (adminDayCounts[b.adminId] ?? 0) + 1;
  }

  for (const [adminId, count] of Object.entries(adminDayCounts)) {
    if (count >= project.maxSessionsPerAdminPerDay) {
      blockedAdmins.add(adminId);
    }
  }

  for (const adminId of rangeAvailable) {
    if (blockedAdmins.has(adminId)) continue;
    const conflict = await hasSchedulingConflict(adminId, dateKey, time, project.durationMinutes, project.bufferMinutes, undefined, client);
    if (conflict) blockedAdmins.add(adminId);
  }

  return rangeAvailable.filter((id) => !blockedAdmins.has(id));
}

export async function validateAdminChoice(
  projectId: string,
  adminId: string,
  dateKey: string,
  time: string,
  tx?: Prisma.TransactionClient
): Promise<boolean> {
  const eligible = await getEligibleAdmins(projectId, dateKey, time, tx);
  return eligible.includes(adminId);
}

export async function pickAvailableAdmin(
  projectId: string,
  dateKey: string,
  time: string,
  tx?: Prisma.TransactionClient
): Promise<AdminInfo | null> {
  const client = tx ?? db;

  const available = await getEligibleAdmins(projectId, dateKey, time, tx);
  if (available.length === 0) return null;

  const totalCounts = await client.booking.groupBy({
    by: ["adminId"],
    where: {
      projectId,
      adminId: { in: available },
      status: "confirmed",
    },
    _count: { id: true },
  });

  const countMap: Record<string, number> = {};
  for (const row of totalCounts) {
    countMap[row.adminId] = row._count.id;
  }

  available.sort((a, b) => {
    const ca = countMap[a] ?? 0;
    const cb = countMap[b] ?? 0;
    if (ca !== cb) return ca - cb;
    return a.localeCompare(b);
  });

  const picked = await client.admin.findUnique({
    where: { id: available[0] },
    select: { id: true, name: true, initials: true },
  });

  return picked;
}

export type AdminInfoBrief = { id: string; name: string; initials: string };

export async function getSlotAdminMap(
  projectId: string,
  availability: Record<string, string[]>
): Promise<Record<string, Record<string, AdminInfoBrief[]>>> {
  const slotAdmins: Record<string, Record<string, AdminInfoBrief[]>> = {};
  const client = db;

  const adminCache = new Map<string, AdminInfoBrief>();

  for (const [dateKey, times] of Object.entries(availability)) {
    slotAdmins[dateKey] = {};
    for (const time of times) {
      const eligibleIds = await getEligibleAdmins(projectId, dateKey, time);
      const admins: AdminInfoBrief[] = [];
      for (const id of eligibleIds) {
        let brief = adminCache.get(id);
        if (!brief) {
          const row = await client.admin.findUnique({
            where: { id },
            select: { id: true, name: true, initials: true },
          });
          if (row) {
            brief = row;
            adminCache.set(id, brief);
          }
        }
        if (brief) admins.push(brief);
      }
      slotAdmins[dateKey][time] = admins;
    }
  }

  return slotAdmins;
}

export async function getParticipantBookingCount(
  projectId: string,
  participantEmail: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? db;
  return client.booking.count({
    where: { projectId, participantEmail: participantEmail.toLowerCase().trim(), status: "confirmed" },
  });
}

type BookingOk = {
  ok: true;
  booking: { id: string; adminId: string; dateKey: string; time: string };
  admin: AdminInfo;
  sessionTypeId: string | null;
  sessionTypeName: string | null;
};
type BookingErr = { ok: false; reason: "slot_full" | "no_admin_available" | "too_short_notice" | "admin_not_eligible" | "max_bookings_reached" };
type BookingResult = BookingOk | BookingErr;

export async function createBooking(input: {
  projectId: string;
  dateKey: string;
  time: string;
  participantName: string;
  participantEmail: string;
  adminId?: string;
  sessionTypeId?: string;
}): Promise<BookingResult> {
  if (typeof input.participantName !== "string" || input.participantName.length === 0 || input.participantName.length > 200 || /[<>]/.test(input.participantName) ||
      typeof input.participantEmail !== "string" || input.participantEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.participantEmail)) {
    return { ok: false, reason: "slot_full" };
  }
  try {
    const result: BookingResult = await db.$transaction(
      async (tx): Promise<BookingResult> => {
        // Serialize writers of THIS slot (project + dateKey + time) at the
        // database level. Only bookings for the same slot contend on the lock,
        // so unrelated slots never block or abort each other. The lock is
        // transaction-scoped (released at commit/rollback) and waiters queue on
        // Postgres' advisory-lock primitives — not on Serializable predicate
        // conflicts — which is what lets non-contending slots proceed in
        // parallel without phantom serialization aborts.
        const slotLocked = await acquireAdvisoryLock(tx, `bslot:${input.projectId}|${input.dateKey}|${input.time}`);
        if (!slotLocked) {
          return { ok: false as const, reason: "slot_full" as const };
        }

        const project = await tx.project.findUnique({
          where: { id: input.projectId },
          select: {
            sessionCapacity: true, minNoticeHours: true, timezone: true, assignmentMode: true,
            maxBookingsPerParticipant: true,
            defaultSessionType: { select: { id: true, name: true } },
          },
        });
        if (!project) {
          return { ok: false as const, reason: "slot_full" as const };
        }

        // Server-side min-notice gate: the availability display now hides
        // slots within the notice window, but the booking API enforces the
        // rule too as a defense-in-depth measure.
        // Negative hoursUntilSession also rejects slots already in the past.
        const hoursUntil = hoursUntilSession(input.dateKey, input.time, project.timezone);
        if (hoursUntil < project.minNoticeHours) {
          return { ok: false as const, reason: "too_short_notice" as const };
        }

        const existingCount = await tx.booking.count({
          where: {
            projectId: input.projectId,
            dateKey: input.dateKey,
            time: input.time,
            status: "confirmed",
          },
        });
        if (existingCount >= project.sessionCapacity) {
          await rescindOffersForSlot(input.projectId, input.dateKey, input.time, tx);
          return { ok: false as const, reason: "slot_full" as const };
        }

        if (project.maxBookingsPerParticipant != null) {
          const participantCount = await getParticipantBookingCount(
            input.projectId, input.participantEmail, tx,
          );
          if (participantCount >= project.maxBookingsPerParticipant) {
            return { ok: false as const, reason: "max_bookings_reached" as const };
          }
        }

        // Admin assignment is serialized per (admin, slot): two concurrent
        // bookings must not both assign the same admin to the same slot time
        // (including across projects), while different admins/slots proceed
        // independently. After taking the admin's lock we re-validate because
        // the admin may have just been booked at this slot by another project.
        let admin: AdminInfo | null = null;

        if (project.assignmentMode === "PARTICIPANT_CHOICE" && input.adminId) {
          // PARTICIPANT_CHOICE: lock the participant's chosen admin, then
          // re-validate all five eligibility gates inside the lock.
          const adminLocked = await acquireAdvisoryLock(tx, `badm:${input.adminId}|${input.dateKey}|${input.time}`);
          if (adminLocked && await validateAdminChoice(input.projectId, input.adminId, input.dateKey, input.time, tx)) {
            const row = await tx.admin.findUnique({
              where: { id: input.adminId },
              select: { id: true, name: true, initials: true },
            });
            if (row) admin = row;
          }
          if (!admin) {
            return { ok: false as const, reason: "admin_not_eligible" as const };
          }
        } else {
          // AUTO mode (default): system picks the admin. Any passed adminId is ignored.
          for (let attempt = 0; attempt < 3; attempt++) {
            const picked = await pickAvailableAdmin(
              input.projectId,
              input.dateKey,
              input.time,
              tx
            );
            if (!picked) break;
            const adminLocked = await acquireAdvisoryLock(tx, `badm:${picked.id}|${input.dateKey}|${input.time}`);
            if (!adminLocked) continue;
            if (await isAdminEligibleForSlot(input.projectId, picked.id, input.dateKey, input.time, tx)) {
              admin = picked;
              break;
            }
          }
          if (!admin) {
            return { ok: false as const, reason: "no_admin_available" as const };
          }
        }

        await tx.participant.upsert({
          where: {
            projectId_email: {
              projectId: input.projectId,
              email: input.participantEmail,
            },
          },
          update: { name: input.participantName, status: "booked" },
          create: {
            projectId: input.projectId,
            name: input.participantName,
            email: input.participantEmail,
            status: "booked",
          },
        });

        // Session type resolution: snapshot the name at booking time for
        // audit accuracy. If an explicit sessionTypeId is provided, validate
        // it exists and is active, then snapshot. Otherwise inherit the
        // project's default type at write time.
        let resolvedSessionTypeId: string | null = null;
        let resolvedSessionTypeName: string | null = null;
        if (input.sessionTypeId) {
          const st = await tx.sessionType.findUnique({
            where: { id: input.sessionTypeId },
            select: { id: true, name: true, isActive: true },
          });
          if (st && st.isActive) {
            resolvedSessionTypeId = st.id;
            resolvedSessionTypeName = st.name;
          }
        }
        if (!resolvedSessionTypeName && project.defaultSessionType) {
          resolvedSessionTypeName = project.defaultSessionType.name;
        }

        const booking = await tx.booking.create({
          data: {
            projectId: input.projectId,
            adminId: admin.id,
            participantName: input.participantName,
            participantEmail: input.participantEmail,
            dateKey: input.dateKey,
            time: input.time,
            status: "confirmed",
            sessionTypeId: resolvedSessionTypeId,
            sessionTypeName: resolvedSessionTypeName,
          },
          select: { id: true, adminId: true, dateKey: true, time: true },
        });

        // The slot just filled (capacity reached): rescind any outstanding
        // waitlist offers for it so they can't be claimed after the fact.
        if (existingCount + 1 >= project.sessionCapacity) {
          await rescindOffersForSlot(input.projectId, input.dateKey, input.time, tx);
        }

        return { ok: true as const, booking, admin, sessionTypeId: resolvedSessionTypeId, sessionTypeName: resolvedSessionTypeName };
      },
      {
        isolationLevel: "ReadCommitted",
        maxWait: 5000,
        timeout: 10000,
      }
    );

    if (result.ok) {
      recordAudit({
        action: "booking_created",
        actorType: "participant",
        actorId: result.booking.adminId,
        actorLabel: input.participantName,
        entityType: "Booking",
        entityId: result.booking.id,
        projectId: input.projectId,
        afterState: {
          dateKey: input.dateKey, time: input.time,
          participantName: input.participantName,
          participantEmail: input.participantEmail,
          adminId: result.booking.adminId,
          sessionTypeId: result.sessionTypeId,
          sessionTypeName: result.sessionTypeName,
        },
      }).catch(() => {});

      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
      // 1. Immediate send with placeholder link.
      await sendNotification("booking_confirmation", {
        id: result.booking.id,
        projectId: input.projectId,
        participantName: input.participantName,
        participantEmail: input.participantEmail,
        dateKey: input.dateKey,
        time: input.time,
        adminId: result.booking.adminId,
      }, {
        meeting_link: "No meeting link available yet — details will follow",
        manage_booking_link: `${baseUrl}/manage/${result.booking.id}`,
      }).catch((err) => console.error(`[notify] Immediate booking_confirmation send failed for booking ${result.booking.id}:`, err));

      // 2. Provision, then send a follow-up either way.
      try {
        await provisionMeeting(input.projectId, result.booking.id);
        // Re-fetch booking to get the real join URL set by provisionMeeting.
        const updatedBooking = await db.booking.findUnique({
          where: { id: result.booking.id },
          select: {
            zoomJoinUrl: true,
            teamsJoinUrl: true,
            meetingPlatform: true,
          },
        });
        const joinUrl = updatedBooking?.meetingPlatform === "zoom"
          ? updatedBooking.zoomJoinUrl
          : updatedBooking?.teamsJoinUrl;
        await sendNotification("booking_confirmation", {
          id: result.booking.id,
          projectId: input.projectId,
          participantName: input.participantName,
          participantEmail: input.participantEmail,
          dateKey: input.dateKey,
          time: input.time,
          adminId: result.booking.adminId,
        }, {
          meeting_link: joinUrl ?? "Meeting link not available",
          manage_booking_link: `${baseUrl}/manage/${result.booking.id}`,
        }).catch((err) => console.error(`[notify] Follow-up booking_confirmation send failed for booking ${result.booking.id}:`, err));
      } catch (err) {
        await sendNotification("booking_confirmation", {
          id: result.booking.id,
          projectId: input.projectId,
          participantName: input.participantName,
          participantEmail: input.participantEmail,
          dateKey: input.dateKey,
          time: input.time,
          adminId: result.booking.adminId,
        }, {
          manage_booking_link: `${baseUrl}/manage/${result.booking.id}`,
        }).catch((err) => console.error(`[notify] Provision-failure booking_confirmation send failed for booking ${result.booking.id}:`, err));
        console.error("Failed to provision meeting:", err);
      }
    }

    return result;
  } catch (err: any) {
    // P2002: unique constraint violation (race on the slot's uniqueness).
    // Serialization conflict: a concurrent transaction just took the slot
    // (Postgres 40001 / Prisma P2034, in whatever shape the driver adapter
    // surfaces it). Both outcomes mean the slot was just taken — return
    // slot_full, not a 500.
    if (err?.code === "P2002" || isSerializationConflict(err)) {
      await rescindOffersForSlot(input.projectId, input.dateKey, input.time).catch(() => {});
      return { ok: false, reason: "slot_full" };
    }
    throw err;
  }
}

export async function cancelBooking(bookingId: string, actor?: { actorType: string; actorLabel: string }) {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, projectId: true, dateKey: true, time: true, participantName: true, participantEmail: true, adminId: true, status: true, teamsMeetingId: true, zoomMeetingId: true },
  });
  if (!booking || booking.status === "cancelled") return null;

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { status: "cancelled" },
    select: { id: true, projectId: true, dateKey: true, time: true, participantName: true, participantEmail: true, adminId: true },
  });

  recordAudit({
    action: "booking_cancelled",
    actorType: actor?.actorType ?? "admin",
    actorId: booking.adminId,
    actorLabel: actor?.actorLabel ?? "System Admin",
    entityType: "Booking",
    entityId: booking.id,
    projectId: booking.projectId,
    beforeState: { status: "confirmed" },
    afterState: { status: "cancelled" },
  }).catch(() => {});

  offerNextWaitlistEntry(booking.projectId, booking.dateKey, booking.time).catch((err) => {
    console.error("Failed to offer waitlist entry after cancellation:", err);
  });

  if (booking.teamsMeetingId || booking.zoomMeetingId) {
    removeMeeting(booking.projectId, booking.id).catch((err) => {
      console.error("Failed to remove meeting after cancellation:", err);
    });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  sendNotification("cancellation_notice", {
    id: booking.id,
    projectId: booking.projectId,
    participantName: booking.participantName,
    participantEmail: booking.participantEmail,
    dateKey: booking.dateKey,
    time: booking.time,
    adminId: booking.adminId,
  }, {
    booking_link: `${baseUrl}/manage/${booking.id}`,
    manage_booking_link: `${baseUrl}/manage/${booking.id}`,
  }).catch(() => {});

  return updated;
}

type RescheduleOk = {
  ok: true;
  oldBooking: { id: string; adminId: string; dateKey: string; time: string };
  newBooking: { id: string; adminId: string; dateKey: string; time: string };
};
type RescheduleErr = { ok: false; reason: "not_found" | "already_resolved" | "slot_full" | "no_admin_available" };
type RescheduleResult = RescheduleOk | RescheduleErr;

export async function rescheduleBookingTime(
  bookingId: string,
  newDateKey: string,
  newTime: string,
  options?: { keepSameAdminIfPossible?: boolean; actor?: { actorType: string; actorLabel: string } }
): Promise<RescheduleResult> {
  const original = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, projectId: true, adminId: true, dateKey: true, time: true, participantName: true, participantEmail: true, status: true, teamsMeetingId: true, calendarEventId: true, zoomMeetingId: true, meetingPlatform: true, zoomAccountId: true },
  });
  if (!original) return { ok: false, reason: "not_found" };
  if (original.status !== "confirmed") return { ok: false, reason: "already_resolved" };

  try {
    const result: RescheduleResult = await db.$transaction(async (tx): Promise<RescheduleResult> => {
      const project = await tx.project.findUnique({
        where: { id: original.projectId },
        select: { sessionCapacity: true },
      });
      if (!project) return { ok: false as const, reason: "slot_full" as const };

      const existingCount = await tx.booking.count({
        where: {
          projectId: original.projectId,
          dateKey: newDateKey,
          time: newTime,
          status: "confirmed",
        },
      });
      if (existingCount >= project.sessionCapacity) {
        return { ok: false as const, reason: "slot_full" as const };
      }

      let targetAdminId = original.adminId;
      if (options?.keepSameAdminIfPossible) {
        const sameOk = await isAdminEligibleForSlot(original.projectId, original.adminId, newDateKey, newTime, tx, original.id);
        if (!sameOk) {
          const picked = await pickAvailableAdmin(original.projectId, newDateKey, newTime, tx);
          if (!picked) return { ok: false as const, reason: "no_admin_available" as const };
          targetAdminId = picked.id;
        }
      } else {
        const picked = await pickAvailableAdmin(original.projectId, newDateKey, newTime, tx);
        if (!picked) return { ok: false as const, reason: "no_admin_available" as const };
        targetAdminId = picked.id;
      }

      await tx.booking.update({
        where: { id: original.id },
        data: { status: "rescheduled" },
      });

      const newBooking = await tx.booking.create({
        data: {
          projectId: original.projectId,
          adminId: targetAdminId,
          participantName: original.participantName,
          participantEmail: original.participantEmail,
          dateKey: newDateKey,
          time: newTime,
          status: "confirmed",
          rescheduledFromId: original.id,
          ...(original.calendarEventId
            ? { calendarEventId: original.calendarEventId }
            : {}),
          ...(original.meetingPlatform
            ? {
                meetingPlatform: original.meetingPlatform,
                ...(original.zoomAccountId ? { zoomAccountId: original.zoomAccountId } : {}),
                ...(original.zoomMeetingId ? { zoomMeetingId: original.zoomMeetingId } : {}),
              }
            : {}),
        },
        select: { id: true, adminId: true, dateKey: true, time: true },
      });

      return { ok: true as const, oldBooking: { id: original.id, adminId: original.adminId, dateKey: original.dateKey, time: original.time }, newBooking };
    }, {
      isolationLevel: "Serializable",
      maxWait: 5000,
      timeout: 10000,
    });

    if (result.ok) {
      const a = options?.actor ?? { actorType: "admin", actorLabel: "System Admin" };
      recordAudit({
        action: "booking_rescheduled",
        actorType: a.actorType,
        actorId: result.oldBooking.adminId,
        actorLabel: a.actorLabel,
        entityType: "Booking",
        entityId: original.id,
        projectId: original.projectId,
        beforeState: { dateKey: original.dateKey, time: original.time, adminId: original.adminId },
        afterState: { dateKey: newDateKey, time: newTime, adminId: result.newBooking.adminId },
      }).catch(() => {});

      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
      sendNotification("reschedule_notice", {
        id: result.newBooking.id,
        projectId: original.projectId,
        participantName: original.participantName,
        participantEmail: original.participantEmail,
        dateKey: newDateKey,
        time: newTime,
        adminId: result.newBooking.adminId,
      }, {
        booking_link: `${baseUrl}/manage/${result.newBooking.id}`,
        manage_booking_link: `${baseUrl}/manage/${result.newBooking.id}`,
        old_session_date: original.dateKey,
        old_session_time: original.time,
      }).catch(() => {});

      offerNextWaitlistEntry(original.projectId, original.dateKey, original.time).catch((err) => {
        console.error("Failed to offer waitlist after reschedule:", err);
      });

      if (original.teamsMeetingId || original.zoomMeetingId) {
        updateMeetingTime(original.projectId, result.newBooking.id, newDateKey, newTime).catch((err) => {
          console.error("Failed to update meeting time after reschedule:", err);
        });
      }
    }

    return result;
  } catch (err: any) {
    if (err?.code === "P2002" || isSerializationConflict(err)) {
      return { ok: false, reason: "slot_full" };
    }
    throw err;
  }
}

export async function isAdminEligibleForSlot(
  projectId: string,
  adminId: string,
  dateKey: string,
  time: string,
  tx?: Prisma.TransactionClient,
  excludeBookingId?: string,
  skipAvailability?: boolean
): Promise<boolean> {
  const client = tx ?? db;
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { durationMinutes: true, bufferMinutes: true, maxSessionsPerAdminPerDay: true },
  });
  if (!project) return false;

  // Deactivated associates are never eligible for new/reassigned bookings.
  const candidate = await client.admin.findUnique({
    where: { id: adminId },
    select: { isActive: true },
  });
  if (!candidate?.isActive) return false;

  // Certification gate: associate must hold all of the project's required
  // certifications (if any). Zero requirements = eligible.
  if (!(await isAdminCertifiedForProject(projectId, adminId, client))) return false;

  if (!skipAvailability) {
    const available = await isAdminAvailableForSlot(adminId, dateKey, time, project.durationMinutes);
    if (!available) return false;
  }

  // maxSessionsPerAdminPerDay is project-scoped
  const dayBookings = await client.booking.findMany({
    where: { projectId, dateKey, adminId, status: "confirmed" },
    select: { time: true },
  });
  if (dayBookings.length >= project.maxSessionsPerAdminPerDay) return false;

  // Cross-project time-overlap check
  const conflict = await hasSchedulingConflict(adminId, dateKey, time, project.durationMinutes, project.bufferMinutes, excludeBookingId, client);
  if (conflict) return false;

  return true;
}

export async function reassignBookingAdmin(
  bookingId: string,
  newAdminId: string,
  actorAdminId?: string,
  actorLabel?: string,
  skipAvailability?: boolean
): Promise<
  { ok: true; booking: { id: string; adminId: string; dateKey: string; time: string } }
  | { ok: false; reason: "not_found" | "already_resolved" | "admin_not_eligible" }
> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, projectId: true, adminId: true, dateKey: true, time: true, participantName: true, participantEmail: true, status: true },
  });
  if (!booking) return { ok: false, reason: "not_found" };
  if (booking.status !== "confirmed") return { ok: false, reason: "already_resolved" };

  // True no-op: reassigning to the admin already on the booking must succeed.
  // Re-running the eligibility checks here would count the booking itself as a
  // conflict (and against maxSessionsPerAdminPerDay), spuriously failing.
  if (newAdminId === booking.adminId) {
    return { ok: true, booking: { id: booking.id, adminId: booking.adminId, dateKey: booking.dateKey, time: booking.time } };
  }

  const eligible = await isAdminEligibleForSlot(booking.projectId, newAdminId, booking.dateKey, booking.time, undefined, undefined, skipAvailability);
  if (!eligible) return { ok: false, reason: "admin_not_eligible" };

  const updated = await db.booking.update({
    where: { id: bookingId },
    data: { adminId: newAdminId },
    select: { id: true, adminId: true, dateKey: true, time: true },
  });

  await recordAudit({
    action: "booking_rescheduled",
    actorType: actorAdminId ? "admin" : "system",
    actorId: actorAdminId,
    actorLabel: actorLabel ?? "System Admin",
    entityType: "Booking",
    entityId: booking.id,
    projectId: booking.projectId,
    beforeState: { dateKey: booking.dateKey, time: booking.time, adminId: booking.adminId },
    afterState: { dateKey: booking.dateKey, time: booking.time, adminId: newAdminId },
  });

  return { ok: true, booking: updated };
}
