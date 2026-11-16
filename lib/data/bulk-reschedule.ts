import { db } from "@/lib/db";
import { isAdminEligibleForSlot, pickAvailableAdmin, reassignBookingAdmin, rescheduleBookingTime } from "@/lib/data/bookings";
import { isAdminUnavailableProjectManageable } from "@/lib/admin-unavailable-access";
import type { AuthorizationActor } from "@/lib/authz";

function addDays(dateKey: string, offset: number): string {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

type AdminUnavailablePreviewItem = {
  bookingId: string;
  dateKey: string;
  time: string;
  participantName: string;
  resolution: "reassign_admin" | "needs_manual_attention";
  newAdminId?: string;
  newAdminName?: string;
};

export async function previewAdminUnavailable(
  adminId: string,
  fromDate: string,
  toDate: string
): Promise<AdminUnavailablePreviewItem[]> {
  const bookings = await db.booking.findMany({
    where: {
      adminId,
      dateKey: { gte: fromDate, lte: toDate },
      status: "confirmed",
    },
    select: { id: true, dateKey: true, time: true, participantName: true, projectId: true },
    orderBy: [{ dateKey: "asc" }, { time: "asc" }],
  });

  const result: AdminUnavailablePreviewItem[] = [];
  for (const b of bookings) {
    const projectAdmins = await db.projectAdmin.findMany({
      where: { projectId: b.projectId, adminId: { not: adminId } },
      select: { admin: { select: { id: true, name: true } } },
    });

    let resolved = false;
    for (const pa of projectAdmins) {
      const eligible = await isAdminEligibleForSlot(b.projectId, pa.admin.id, b.dateKey, b.time);
      if (eligible) {
        result.push({
          bookingId: b.id,
          dateKey: b.dateKey,
          time: b.time,
          participantName: b.participantName,
          resolution: "reassign_admin",
          newAdminId: pa.admin.id,
          newAdminName: pa.admin.name,
        });
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      result.push({
        bookingId: b.id,
        dateKey: b.dateKey,
        time: b.time,
        participantName: b.participantName,
        resolution: "needs_manual_attention",
      });
    }
  }
  return result;
}

export async function commitAdminUnavailable(
  adminId: string,
  fromDate: string,
  toDate: string,
  actor: AuthorizationActor,
  actorLabel: string,
): Promise<{ succeeded: number; failed: { bookingId: string; reason: string }[] }> {
  const bookings = await db.booking.findMany({
    where: {
      adminId,
      dateKey: { gte: fromDate, lte: toDate },
      status: "confirmed",
    },
    select: { id: true, dateKey: true, time: true, participantName: true, projectId: true },
    orderBy: [{ dateKey: "asc" }, { time: "asc" }],
  });

  let succeeded = 0;
  const failed: { bookingId: string; reason: string }[] = [];

  for (const b of bookings) {
    if (!(await isAdminUnavailableProjectManageable(actor, b.projectId))) {
      failed.push({ bookingId: b.id, reason: "project_not_managed" });
      continue;
    }

    const projectAdmins = await db.projectAdmin.findMany({
      where: { projectId: b.projectId, adminId: { not: adminId } },
      select: { admin: { select: { id: true, name: true } } },
    });

    let assigned = false;
    for (const pa of projectAdmins) {
      const eligible = await isAdminEligibleForSlot(b.projectId, pa.admin.id, b.dateKey, b.time);
      if (eligible) {
        if (!(await isAdminUnavailableProjectManageable(actor, b.projectId))) {
          failed.push({ bookingId: b.id, reason: "project_not_managed" });
          assigned = true;
          break;
        }
        const result = await reassignBookingAdmin(b.id, pa.admin.id, actor.id, actorLabel);
        if (result.ok) {
          succeeded++;
          assigned = true;
          break;
        } else {
          failed.push({ bookingId: b.id, reason: result.reason });
          assigned = true;
          break;
        }
      }
    }
    if (!assigned) {
      failed.push({ bookingId: b.id, reason: "needs_manual_attention" });
    }
  }

  return { succeeded, failed };
}

type DateShiftPreviewItem = {
  bookingId: string;
  oldDateKey: string;
  time: string;
  newDateKey: string;
  participantName: string;
  projectId: string;
  resolution: "same_admin_available" | "reassign_needed" | "slot_full_at_target" | "no_admin_available_at_target";
  resultingAdminId?: string;
  resultingAdminName?: string;
};

export async function previewDateShift(
  projectId: string,
  fromDate: string,
  toDate: string,
  offsetDays: number
): Promise<DateShiftPreviewItem[]> {
  const bookings = await db.booking.findMany({
    where: {
      projectId,
      dateKey: { gte: fromDate, lte: toDate },
      status: "confirmed",
    },
    select: { id: true, dateKey: true, time: true, participantName: true, adminId: true, projectId: true },
    orderBy: [{ dateKey: "asc" }, { time: "asc" }],
  });

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { sessionCapacity: true, name: true, company: true },
  });
  if (!project) return [];

  const result: DateShiftPreviewItem[] = [];
  for (const b of bookings) {
    const newDateKey = addDays(b.dateKey, offsetDays);

    const existingCount = await db.booking.count({
      where: { projectId, dateKey: newDateKey, time: b.time, status: "confirmed" },
    });
    if (existingCount >= project.sessionCapacity) {
      result.push({
        bookingId: b.id,
        oldDateKey: b.dateKey,
        time: b.time,
        newDateKey,
        participantName: b.participantName,
        projectId,
        resolution: "slot_full_at_target",
      });
      continue;
    }

    const sameAdminOk = await isAdminEligibleForSlot(projectId, b.adminId, newDateKey, b.time);
    if (sameAdminOk) {
      result.push({
        bookingId: b.id,
        oldDateKey: b.dateKey,
        time: b.time,
        newDateKey,
        participantName: b.participantName,
        projectId,
        resolution: "same_admin_available",
        resultingAdminId: b.adminId,
      });
      continue;
    }

    const picked = await pickAvailableAdmin(projectId, newDateKey, b.time);
    if (picked) {
      result.push({
        bookingId: b.id,
        oldDateKey: b.dateKey,
        time: b.time,
        newDateKey,
        participantName: b.participantName,
        projectId,
        resolution: "reassign_needed",
        resultingAdminId: picked.id,
        resultingAdminName: picked.name,
      });
    } else {
      result.push({
        bookingId: b.id,
        oldDateKey: b.dateKey,
        time: b.time,
        newDateKey,
        participantName: b.participantName,
        projectId,
        resolution: "no_admin_available_at_target",
      });
    }
  }
  return result;
}

export async function commitDateShift(
  projectId: string,
  fromDate: string,
  toDate: string,
  offsetDays: number,
  actor: AuthorizationActor,
  actorLabel: string
): Promise<{ succeeded: number; failed: { bookingId: string; reason: string }[] }> {
  const bookings = await db.booking.findMany({
    where: {
      projectId,
      dateKey: { gte: fromDate, lte: toDate },
      status: "confirmed",
    },
    select: { id: true, dateKey: true, time: true, adminId: true },
    orderBy: [{ dateKey: "asc" }, { time: "asc" }],
  });

  let succeeded = 0;
  const failed: { bookingId: string; reason: string }[] = [];

  for (const b of bookings) {
    const newDateKey = addDays(b.dateKey, offsetDays);
    const result = await rescheduleBookingTime(b.id, newDateKey, b.time, { keepSameAdminIfPossible: true, actor: { actorType: "admin", actorLabel } });
    if (result.ok) {
      succeeded++;
    } else {
      failed.push({ bookingId: b.id, reason: result.reason });
    }
  }

  return { succeeded, failed };
}

export { isAdminEligibleForSlot };
