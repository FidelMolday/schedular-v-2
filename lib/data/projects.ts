import { db } from "@/lib/db";
import { recordAudit } from "@/lib/data/audit";
import { offboardAdminFromProject } from "@/lib/data/offboarding";
import { DEMO_SLUG } from "@/lib/demo";

export type ProjectWithAdmins = {
  id: string;
  slug: string;
  name: string;
  company: string;
  description: string;
  durationMinutes: number;
  availabilityPeriodDays: number;
  dailyStart: string;
  dailyEnd: string;
  includeWeekends: boolean;
  minNoticeHours: number;
  timezone: string;
  bookingDeadlineDays: number;
  bufferMinutes: number;
  maxSessionsPerAdminPerDay: number;
  sessionCapacity: number;
  autoCompleteBookings: boolean;
  status: "draft" | "active" | "paused" | "closed" | "archived";
  availabilityLockDate: Date;
  branding: { logoInitial: string; primaryColor: string; senderName: string };
  admins: { id: string; name: string; initials: string }[];
  ownerId: string | null;
  ownerName: string | null;
  meetingPlatformPreference: "zoom" | "teams" | "auto";
  assignmentMode: "AUTO" | "PARTICIPANT_CHOICE";
  maxBookingsPerParticipant: number | null;
  lockRescheduleToOriginalAdmin: boolean;
  defaultSessionTypeId: string | null;
  defaultSessionTypeName: string | null;
  reminderSchedules: { id: string; hoursBefore: number; label: string }[];
  createdAt: Date;
  updatedAt: Date;
};

function toProjectWithAdmins(row: {
  id: string;
  slug: string;
  name: string;
  company: string;
  description: string;
  durationMinutes: number;
  availabilityPeriodDays: number;
  dailyStart: string;
  dailyEnd: string;
  includeWeekends: boolean;
  minNoticeHours: number;
  timezone: string;
  bookingDeadlineDays: number;
  bufferMinutes: number;
  maxSessionsPerAdminPerDay: number;
  sessionCapacity: number;
  autoCompleteBookings: boolean;
  status: string;
  availabilityLockDate: Date;
  brandingLogoInitial: string;
  brandingPrimaryColor: string;
  brandingSenderName: string;
  admins?: { admin: { id: string; name: string; initials: string } }[];
  ownerId: string | null;
  owner?: { name: string } | null;
  meetingPlatformPreference: "zoom" | "teams" | "auto";
  assignmentMode: "AUTO" | "PARTICIPANT_CHOICE";
  maxBookingsPerParticipant: number | null;
  lockRescheduleToOriginalAdmin: boolean;
  defaultSessionTypeId: string | null;
  defaultSessionType?: { id: string; name: string } | null;
  reminderSchedules?: { id: string; hoursBefore: number; label: string }[];
  createdAt: Date;
  updatedAt: Date;
}): ProjectWithAdmins {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    company: row.company,
    description: row.description,
    durationMinutes: row.durationMinutes,
    availabilityPeriodDays: row.availabilityPeriodDays,
    dailyStart: row.dailyStart,
    dailyEnd: row.dailyEnd,
    includeWeekends: row.includeWeekends,
    minNoticeHours: row.minNoticeHours,
    timezone: row.timezone,
    bookingDeadlineDays: row.bookingDeadlineDays,
    bufferMinutes: row.bufferMinutes,
    maxSessionsPerAdminPerDay: row.maxSessionsPerAdminPerDay,
    sessionCapacity: row.sessionCapacity,
    status: row.status as ProjectWithAdmins["status"],
    autoCompleteBookings: row.autoCompleteBookings,
    availabilityLockDate: row.availabilityLockDate,
    branding: {
      logoInitial: row.brandingLogoInitial,
      primaryColor: row.brandingPrimaryColor,
      senderName: row.brandingSenderName,
    },
    ownerId: row.ownerId,
    ownerName: row.owner?.name ?? null,
    meetingPlatformPreference: row.meetingPlatformPreference,
    assignmentMode: row.assignmentMode,
    maxBookingsPerParticipant: row.maxBookingsPerParticipant ?? null,
    lockRescheduleToOriginalAdmin: row.lockRescheduleToOriginalAdmin,
    defaultSessionTypeId: row.defaultSessionTypeId,
    defaultSessionTypeName: row.defaultSessionType?.name ?? null,
    reminderSchedules: row.reminderSchedules ?? [],
    admins: (row.admins ?? []).map((pa) => ({
      id: pa.admin.id,
      name: pa.admin.name,
      initials: pa.admin.initials,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";
}

export async function listProjects(ownerId?: string): Promise<ProjectWithAdmins[]> {
  const where: { ownerId?: string; NOT?: { slug: string } } = ownerId ? { ownerId } : { NOT: { slug: DEMO_SLUG } };
  const rows = await db.project.findMany({
    where,
    include: { admins: { include: { admin: true } }, owner: { select: { name: true } }, defaultSessionType: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toProjectWithAdmins);
}

export async function listProjectsForAdmin(adminId: string): Promise<ProjectWithAdmins[]> {
  const rows = await db.project.findMany({
    where: { NOT: { slug: DEMO_SLUG }, admins: { some: { adminId } } },
    include: { admins: { include: { admin: true } }, owner: { select: { name: true } }, defaultSessionType: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toProjectWithAdmins);
}

export async function getProjectBySlug(slug: string): Promise<ProjectWithAdmins | null> {
  const row = await db.project.findUnique({
    where: { slug },
      include: {
        admins: { include: { admin: true } },
        owner: { select: { name: true } },
        defaultSessionType: { select: { id: true, name: true } },
        reminderSchedules: { orderBy: { hoursBefore: "desc" }, select: { id: true, hoursBefore: true, label: true } },
      },
  });
  return row ? toProjectWithAdmins(row) : null;
}

export async function createProject(input: {
  name: string;
  company: string;
  description: string;
  durationMinutes: number;
  dailyStart: string;
  dailyEnd: string;
  includeWeekends: boolean;
  minNoticeHours: number;
  timezone: string;
  bookingDeadlineDays: number;
  bufferMinutes: number;
  maxSessionsPerAdminPerDay: number;
  sessionCapacity: number;
  availabilityLockDate: Date;
  branding: { logoInitial: string; primaryColor: string; senderName: string };
  status?: "draft" | "active" | "paused" | "closed" | "archived";
  availabilityPeriodDays: number;
  adminIds: string[];
  ownerId?: string;
  autoCompleteBookings?: boolean;
  meetingPlatformPreference?: "zoom" | "teams" | "auto";
  assignmentMode?: "AUTO" | "PARTICIPANT_CHOICE";
  maxBookingsPerParticipant?: number | null;
  defaultSessionTypeId?: string | null;
}): Promise<ProjectWithAdmins> {
  let slug = slugify(input.name);

  const existing = await db.project.findUnique({ where: { slug } });
  if (existing) {
    let i = 2;
    while (await db.project.findUnique({ where: { slug: `${slug}-${i}` } })) i++;
    slug = `${slug}-${i}`;
  }

  const row = await db.project.create({
    data: {
      slug,
      name: input.name,
      company: input.company,
      description: input.description,
      durationMinutes: input.durationMinutes,
      availabilityPeriodDays: input.availabilityPeriodDays,
      dailyStart: input.dailyStart,
      dailyEnd: input.dailyEnd,
      includeWeekends: input.includeWeekends,
      minNoticeHours: input.minNoticeHours,
      timezone: input.timezone,
      bookingDeadlineDays: input.bookingDeadlineDays,
      bufferMinutes: input.bufferMinutes,
      maxSessionsPerAdminPerDay: input.maxSessionsPerAdminPerDay,
      sessionCapacity: input.sessionCapacity,
      autoCompleteBookings: input.autoCompleteBookings ?? false,
      status: input.status ?? "draft",
      availabilityLockDate: input.availabilityLockDate,
      brandingLogoInitial: input.branding.logoInitial,
      brandingPrimaryColor: input.branding.primaryColor,
      brandingSenderName: input.branding.senderName,
      meetingPlatformPreference: input.meetingPlatformPreference ?? "auto",
      assignmentMode: input.assignmentMode ?? "AUTO",
      maxBookingsPerParticipant: input.maxBookingsPerParticipant ?? null,
      defaultSessionTypeId: input.defaultSessionTypeId ?? null,
      ownerId: input.ownerId ?? null,
      admins: {
        create: input.adminIds.map((adminId) => ({ adminId })),
      },
    },
    include: { admins: { include: { admin: true } }, owner: { select: { name: true } } },
  });

  // Audit: non-blocking, outside transaction — failure won't affect the create
  recordAudit({
    action: "project_created",
    actorType: "super_admin",
    actorLabel: "Unknown (auth not yet wired)", // TODO: replace with session.user once auth lands
    entityType: "Project",
    entityId: row.id,
    projectId: row.id,
    afterState: { ...row, admins: row.admins.length },
  }).catch(() => {});

  return toProjectWithAdmins(row);
}

export type OffboardingSummary = {
  reassigned: { bookingId: string; oldAdminId: string; newAdminId: string }[];
  flagged: { bookingId: string; reason: string }[];
};

export async function updateProject(
  slug: string,
  updates: {
    name: string;
    company: string;
    description: string;
    durationMinutes: number;
    dailyStart: string;
    dailyEnd: string;
    includeWeekends: boolean;
    minNoticeHours: number;
    timezone: string;
    bookingDeadlineDays: number;
    bufferMinutes: number;
    maxSessionsPerAdminPerDay: number;
    sessionCapacity: number;
    availabilityLockDate: Date;
    branding: { logoInitial: string; primaryColor: string; senderName: string };
    status: "draft" | "active" | "paused" | "closed" | "archived";
    availabilityPeriodDays: number;
    adminIds: string[];
    ownerId?: string;
    autoCompleteBookings?: boolean;
    meetingPlatformPreference?: "zoom" | "teams" | "auto";
    assignmentMode?: "AUTO" | "PARTICIPANT_CHOICE";
    maxBookingsPerParticipant?: number | null;
    lockRescheduleToOriginalAdmin?: boolean;
    defaultSessionTypeId?: string | null;
  }
): Promise<{ project: ProjectWithAdmins; offboarding: OffboardingSummary }> {
  const existing = await db.project.findUnique({ where: { slug } });
  if (!existing) throw new Error(`Project "${slug}" not found`);

  // Capture old admin list BEFORE the transaction
  const oldAdminRows = await db.projectAdmin.findMany({
    where: { projectId: existing.id },
    select: { adminId: true },
  });
  const oldAdminIds = new Set(oldAdminRows.map((pa) => pa.adminId));
  const newAdminIds = new Set(updates.adminIds);

  // Find admins being REMOVED (in old but not in new)
  const removedAdminIds = [...oldAdminIds].filter((id) => !newAdminIds.has(id));
  // Remaining admins after removal (new list)
  const remainingAdminIds = updates.adminIds.filter((id) => oldAdminIds.has(id) && newAdminIds.has(id))
    .concat([...newAdminIds].filter((id) => !oldAdminIds.has(id)));

  const beforeSnapshot = {
    name: existing.name, company: existing.company, status: existing.status,
    description: existing.description, durationMinutes: existing.durationMinutes,
    dailyStart: existing.dailyStart, dailyEnd: existing.dailyEnd,
    timezone: existing.timezone, sessionCapacity: existing.sessionCapacity,
    maxSessionsPerAdminPerDay: existing.maxSessionsPerAdminPerDay,
    bufferMinutes: existing.bufferMinutes, minNoticeHours: existing.minNoticeHours,
    bookingDeadlineDays: existing.bookingDeadlineDays,
    availabilityPeriodDays: existing.availabilityPeriodDays,
    includeWeekends: existing.includeWeekends,
    availabilityLockDate: existing.availabilityLockDate,
    branding: { logoInitial: existing.brandingLogoInitial, primaryColor: existing.brandingPrimaryColor, senderName: existing.brandingSenderName },
  };

  const row = await db.$transaction(async (tx) => {
    // Reconcile admin assignments
    await tx.projectAdmin.deleteMany({ where: { projectId: existing.id } });
    if (updates.adminIds.length > 0) {
      await tx.projectAdmin.createMany({
        data: updates.adminIds.map((adminId) => ({
          projectId: existing.id,
          adminId,
        })),
      });
    }

    const updateData: Record<string, unknown> = {
      name: updates.name,
      company: updates.company,
      description: updates.description,
      durationMinutes: updates.durationMinutes,
      availabilityPeriodDays: updates.availabilityPeriodDays,
      dailyStart: updates.dailyStart,
      dailyEnd: updates.dailyEnd,
      includeWeekends: updates.includeWeekends,
      minNoticeHours: updates.minNoticeHours,
      timezone: updates.timezone,
      bookingDeadlineDays: updates.bookingDeadlineDays,
      bufferMinutes: updates.bufferMinutes,
      maxSessionsPerAdminPerDay: updates.maxSessionsPerAdminPerDay,
      sessionCapacity: updates.sessionCapacity,
      status: updates.status,
      availabilityLockDate: updates.availabilityLockDate,
      brandingLogoInitial: updates.branding.logoInitial,
      brandingPrimaryColor: updates.branding.primaryColor,
      brandingSenderName: updates.branding.senderName,
    };
    if (updates.ownerId !== undefined) {
      updateData.ownerId = updates.ownerId;
    }
    if (updates.autoCompleteBookings !== undefined) {
      updateData.autoCompleteBookings = updates.autoCompleteBookings;
    }
    if (updates.meetingPlatformPreference !== undefined) {
      updateData.meetingPlatformPreference = updates.meetingPlatformPreference;
    }
    if (updates.assignmentMode !== undefined) {
      updateData.assignmentMode = updates.assignmentMode;
    }
    if (updates.defaultSessionTypeId !== undefined) {
      updateData.defaultSessionTypeId = updates.defaultSessionTypeId;
    }
    if (updates.maxBookingsPerParticipant !== undefined) {
      updateData.maxBookingsPerParticipant = updates.maxBookingsPerParticipant;
    }
    if (updates.lockRescheduleToOriginalAdmin !== undefined) {
      updateData.lockRescheduleToOriginalAdmin = updates.lockRescheduleToOriginalAdmin;
    }

    return tx.project.update({
      where: { id: existing.id },
      data: updateData,
    include: { admins: { include: { admin: true } }, owner: { select: { name: true } } },
    });
  });

  // Audit: non-blocking, outside transaction
  recordAudit({
    action: "project_updated",
    actorType: "super_admin",
    actorLabel: "Unknown (auth not yet wired)", // TODO: replace with session.user once auth lands
    entityType: "Project",
    entityId: row.id,
    projectId: row.id,
    beforeState: beforeSnapshot,
    afterState: {
      name: row.name, company: row.company, status: row.status,
      description: row.description, durationMinutes: row.durationMinutes,
      dailyStart: row.dailyStart, dailyEnd: row.dailyEnd,
      timezone: row.timezone, sessionCapacity: row.sessionCapacity,
      maxSessionsPerAdminPerDay: row.maxSessionsPerAdminPerDay,
      bufferMinutes: row.bufferMinutes, minNoticeHours: row.minNoticeHours,
      bookingDeadlineDays: row.bookingDeadlineDays,
      availabilityPeriodDays: row.availabilityPeriodDays,
      includeWeekends: row.includeWeekends,
      availabilityLockDate: row.availabilityLockDate,
      branding: { logoInitial: row.brandingLogoInitial, primaryColor: row.brandingPrimaryColor, senderName: row.brandingSenderName },
    },
  }).catch(() => {});

  // Offboard removed admins: non-blocking, failure never affects the project update
  let offboarding: OffboardingSummary = { reassigned: [], flagged: [] };
  if (removedAdminIds.length > 0) {
    try {
      for (const removedId of removedAdminIds) {
        const result = await offboardAdminFromProject(existing.id, removedId, remainingAdminIds);
        offboarding.reassigned.push(...result.reassigned);
        offboarding.flagged.push(...result.flagged);
      }
    } catch (err) {
      console.error("Offboarding side-effect failed (non-blocking):", err);
    }
  }

  return { project: toProjectWithAdmins(row), offboarding };
}
