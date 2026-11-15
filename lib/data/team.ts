import { db } from "@/lib/db";
import { offboardAdminFromProject } from "@/lib/data/offboarding";
import { recordAudit } from "@/lib/data/audit";
import { DEMO_STAFF_IDS } from "@/lib/demo";

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  accountType: string | null;
  ownedProjectNames: string[];
  assignedProjectNames: string[];
  isActive: boolean;
  deactivatedAt: string | null;
  deactivatedBy: string | null;
};

export async function listTeamMembers(): Promise<TeamMember[]> {
  const admins = await db.admin.findMany({
    where: { id: { notIn: DEMO_STAFF_IDS } },
    orderBy: { name: "asc" },
    include: {
      ownedProjects: { select: { name: true } },
      projectAssignments: { select: { project: { select: { name: true } } } },
    },
  });

  return admins.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    accountType: a.accountType,
    ownedProjectNames: a.ownedProjects.map((p) => p.name),
    assignedProjectNames: a.projectAssignments.map((pa) => pa.project.name),
    isActive: a.isActive,
    deactivatedAt: a.deactivatedAt ? a.deactivatedAt.toISOString() : null,
    deactivatedBy: a.deactivatedBy,
  }));
}

/**
 * Change an admin's role between "admin" and "super_admin" only.
 *
 * Allowed for org_owner and super_admin callers (super_admin can manage
 * every associate system-wide on the Team page — a deliberate exception
 * to normal project-ownership scoping; everything else stays scoped).
 *
 * Org-owner can NEVER be set or removed through this path — ownership
 * changes only via the dedicated `promoteToOrgOwner` transfer flow,
 * which atomically demotes the current owner while promoting the new one.
 *
 * The current org_owner's role cannot be changed through this path either;
 * they can only lose org_owner via someone else being promoted.
 */
export async function changeAdminRole(
  actorAdminId: string,
  targetAdminId: string,
  newRole: "admin" | "super_admin"
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_allowed"
        | "target_not_found"
        | "cannot_change_org_owner_role";
    }
> {
  const actor = await db.admin.findUnique({
    where: { id: actorAdminId },
    select: { role: true, name: true, email: true, isActive: true },
  });
  if (!actor || !actor.isActive || (actor.role !== "org_owner" && actor.role !== "super_admin")) {
    return { ok: false, reason: "not_allowed" };
  }

  const target = await db.admin.findUnique({
    where: { id: targetAdminId },
    select: { id: true, role: true, name: true, email: true },
  });
  if (!target) {
    return { ok: false, reason: "target_not_found" };
  }

  // org_owner's role cannot be changed via this path — only via promoteToOrgOwner transfer
  if (target.role === "org_owner") {
    return { ok: false, reason: "cannot_change_org_owner_role" };
  }

  const oldRole = target.role;

  await db.$transaction([
    db.admin.update({
      where: { id: targetAdminId },
      data: { role: newRole },
    }),
    db.auditLog.create({
      data: {
        action: "role_changed",
        actorType: "admin",
        actorId: actorAdminId,
        actorLabel: `${actor.name} <${actor.email}>`,
        entityType: "Admin",
        entityId: targetAdminId,
        beforeState: { role: oldRole },
        afterState: { role: newRole },
      },
    }),
  ]);

  return { ok: true };
}

/**
 * Transfer org ownership from the current owner to a new person.
 *
 * This is the ONLY way to change who the org_owner is. It performs an
 * atomic transaction that:
 *  1. Demotes the current org_owner (actorAdminId) to super_admin
 *     — they keep their projects and assignments, just lose the top-level tier.
 *  2. Promotes the target (targetAdminId) to org_owner.
 *  3. Writes a single org_ownership_transferred audit log entry.
 *
 * If either update fails, the entire transaction rolls back so there is
 * never a moment with zero or two org_owners.
 */
export async function promoteToOrgOwner(
  actorAdminId: string,
  targetAdminId: string,
  confirmationPhrase: string
): Promise<
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_org_owner"
        | "target_not_found"
        | "already_org_owner"
        | "confirmation_mismatch";
    }
> {
  const actor = await db.admin.findUnique({
    where: { id: actorAdminId },
    select: { id: true, role: true, name: true, email: true, isActive: true },
  });
  if (!actor || !actor.isActive || actor.role !== "org_owner") {
    return { ok: false, reason: "not_org_owner" };
  }

  const target = await db.admin.findUnique({
    where: { id: targetAdminId },
    select: { id: true, role: true, name: true, email: true },
  });
  if (!target) {
    return { ok: false, reason: "target_not_found" };
  }

  // Target is already the org_owner — no-op
  if (target.role === "org_owner") {
    return { ok: false, reason: "already_org_owner" };
  }

  // Confirmation phrase must match target's email exactly
  if (confirmationPhrase !== target.email) {
    return { ok: false, reason: "confirmation_mismatch" };
  }

  // Atomic transfer: demote current owner to super_admin, promote target
  await db.$transaction([
    db.admin.update({
      where: { id: actorAdminId },
      data: { role: "super_admin" },
    }),
    db.admin.update({
      where: { id: targetAdminId },
      data: { role: "org_owner" },
    }),
    db.auditLog.create({
      data: {
        action: "org_ownership_transferred",
        actorType: "admin",
        actorId: actorAdminId,
        actorLabel: `${actor.name} <${actor.email}>`,
        entityType: "Admin",
        entityId: targetAdminId,
        beforeState: {
          previousOwnerId: actorAdminId,
          previousOwnerEmail: actor.email,
        },
        afterState: {
          newOwnerId: targetAdminId,
          newOwnerEmail: target.email,
        },
      },
    }),
  ]);

  return { ok: true };
}

export type OffboardingSummary = {
  reassigned: { bookingId: string; oldAdminId: string; newAdminId: string }[];
  flagged: { bookingId: string; reason: string }[];
};

export type DeactivateResult =
  | {
      ok: true;
      offboarding: OffboardingSummary;
      projectsRemoved: string[];
      alreadyDeactivated?: boolean;
    }
  | {
      ok: false;
      reason:
        | "not_authorized"
        | "target_not_found"
        | "cannot_deactivate_self"
        | "cannot_deactivate_sole_org_owner";
    };

/**
 * Soft-deactivate an associate (org_owner or super_admin actor, matching the
 * Phase-2-confirmed system-wide Team-page access).
 *
 * - The target can never deactivate themselves — someone else must do it.
 * - The sole org_owner can never be deactivated (structural guarantee that
 *   the system always keeps an org_owner, same as the single-seat model).
 * - On success: isActive=false, deactivatedAt=now(), deactivatedBy=actor id.
 * - ALL of the target's ProjectAdmin assignments are removed so they can no
 *   longer be assigned/eligible for NEW bookings anywhere.
 * - Every project the target is assigned to runs the existing
 *   `offboardAdminFromProject` flow (reused verbatim — same logic as the
 *   "removed from a project" case) so their existing FUTURE confirmed
 *   bookings are reassigned to an eligible remaining associate or flagged
 *   for manual attention, exactly like the existing off-boarding feature.
 * - No Booking / AuditLog / AdminAvailabilityRange / Certification rows are
 *   deleted or modified — historical data stays completely intact.
 * - Writes an "admin_deactivated" audit entry.
 */
export async function deactivateAdmin(
  actorAdminId: string,
  targetAdminId: string
): Promise<DeactivateResult> {
  const actor = await db.admin.findUnique({
    where: { id: actorAdminId },
    select: { id: true, role: true, name: true, email: true, isActive: true },
  });
  if (!actor || !actor.isActive || (actor.role !== "org_owner" && actor.role !== "super_admin")) {
    return { ok: false, reason: "not_authorized" };
  }

  const target = await db.admin.findUnique({
    where: { id: targetAdminId },
    select: { id: true, role: true, name: true, email: true, isActive: true },
  });
  if (!target) {
    return { ok: false, reason: "target_not_found" };
  }
  if (target.id === actor.id) {
    return { ok: false, reason: "cannot_deactivate_self" };
  }
  if (target.role === "org_owner") {
    return { ok: false, reason: "cannot_deactivate_sole_org_owner" };
  }
  if (!target.isActive) {
    return { ok: true, offboarding: { reassigned: [], flagged: [] }, projectsRemoved: [], alreadyDeactivated: true };
  }

  const assignments = await db.projectAdmin.findMany({
    where: { adminId: target.id },
    select: { projectId: true },
  });

  const offboarding: OffboardingSummary = { reassigned: [], flagged: [] };
  for (const { projectId } of assignments) {
    try {
      const remaining = await db.projectAdmin.findMany({
        where: {
          projectId,
          adminId: { not: target.id },
          admin: { isActive: true },
        },
        select: { adminId: true },
      });
      const result = await offboardAdminFromProject(
        projectId,
        target.id,
        remaining.map((r) => r.adminId)
      );
      offboarding.reassigned.push(...result.reassigned);
      offboarding.flagged.push(...result.flagged);
    } catch (err) {
      console.error(`Offboarding during deactivation failed for project ${projectId}:`, err);
    }
  }

  const deactivatedAt = new Date();

  await db.$transaction([
    db.projectAdmin.deleteMany({ where: { adminId: target.id } }),
    db.admin.update({
      where: { id: target.id },
      data: { isActive: false, deactivatedAt, deactivatedBy: actor.id },
    }),
  ]);

  recordAudit({
    action: "admin_deactivated",
    actorType: "admin",
    actorId: actor.id,
    actorLabel: `${actor.name} <${actor.email}>`,
    entityType: "Admin",
    entityId: target.id,
    beforeState: { isActive: true, role: target.role },
    afterState: {
      isActive: false,
      deactivatedAt: deactivatedAt.toISOString(),
      deactivatedBy: actor.id,
      role: target.role,
      removedProjects: assignments.map((a) => a.projectId),
      offboarding: {
        reassigned: offboarding.reassigned,
        flagged: offboarding.flagged,
      },
    },
  }).catch(() => {});

  return {
    ok: true,
    offboarding,
    projectsRemoved: assignments.map((a) => a.projectId),
  };
}

export type ReactivateResult =
  | { ok: true; alreadyActive?: boolean }
  | { ok: false; reason: "not_authorized" | "target_not_found" };

/**
 * Reverse of `deactivateAdmin` (org_owner or super_admin actor):
 * sets isActive=true and clears deactivatedAt/deactivatedBy.
 *
 * Deliberately does NOT restore the target's old ProjectAdmin assignments —
 * projects/rules may have changed while they were away, so assignments must
 * be re-added manually afterwards (same reasoning the ProjectForm treats
 * assignment as an explicit, current decision).
 */
export async function reactivateAdmin(
  actorAdminId: string,
  targetAdminId: string
): Promise<ReactivateResult> {
  const actor = await db.admin.findUnique({
    where: { id: actorAdminId },
    select: { id: true, role: true, name: true, email: true, isActive: true },
  });
  if (!actor || !actor.isActive || (actor.role !== "org_owner" && actor.role !== "super_admin")) {
    return { ok: false, reason: "not_authorized" };
  }

  const target = await db.admin.findUnique({
    where: { id: targetAdminId },
    select: { id: true, role: true, name: true, email: true, isActive: true },
  });
  if (!target) {
    return { ok: false, reason: "target_not_found" };
  }
  if (target.isActive) {
    return { ok: true, alreadyActive: true };
  }

  await db.$transaction([
    db.admin.update({
      where: { id: target.id },
      data: { isActive: true, deactivatedAt: null, deactivatedBy: null },
    }),
    db.auditLog.create({
      data: {
        action: "admin_reactivated",
        actorType: "admin",
        actorId: actor.id,
        actorLabel: `${actor.name} <${actor.email}>`,
        entityType: "Admin",
        entityId: target.id,
        beforeState: { isActive: false },
        afterState: { isActive: true },
      },
    }),
  ]);

  return { ok: true };
}
