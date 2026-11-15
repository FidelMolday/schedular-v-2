import { canManageProject, type AuthorizationActor } from "@/lib/authz";
import { db } from "@/lib/db";

export async function checkAdminUnavailableAccess(
  actor: AuthorizationActor,
  adminId: string,
  fromDate: string,
  toDate: string,
): Promise<boolean> {
  const affectedBookings = await db.booking.findMany({
    where: { adminId, dateKey: { gte: fromDate, lte: toDate }, status: "confirmed" },
    select: { projectId: true },
  });
  const affectedProjectIds = [...new Set(affectedBookings.map((booking) => booking.projectId))];

  if (actor.role === "org_owner") return true;

  const projects = affectedProjectIds.length === 0
    ? []
    : await db.project.findMany({
        where: { id: { in: affectedProjectIds } },
        select: { id: true, ownerId: true },
      });
  const managedProjectIds = new Set(
    projects.filter((project) => canManageProject(actor, project)).map((project) => project.id),
  );
  const allAffectedProjectsManaged = projects.length === affectedProjectIds.length
    && affectedProjectIds.every((projectId) => managedProjectIds.has(projectId));
  if (!allAffectedProjectsManaged) return false;

  if (actor.role === "super_admin") return true;

  // Preserve the existing staff requirement that the target admin belongs to
  // at least one project owned by the caller.
  const inScope = await db.projectAdmin.findFirst({
    where: { adminId, project: { ownerId: actor.id } },
    select: { id: true },
  });
  return Boolean(inScope);
}

export async function isAdminUnavailableProjectManageable(
  actor: AuthorizationActor,
  projectId: string,
): Promise<boolean> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
  return Boolean(project && canManageProject(actor, project));
}
