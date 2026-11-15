import { auth } from "@/auth";
import { db } from "@/lib/db";

export type RoleInfo = {
  id: string;
  role: "admin" | "super_admin" | "org_owner";
};

export type AuthorizationActor = {
  id: string;
  role: "admin" | "super_admin" | "org_owner";
};

export type AuthorizationSession = {
  user?: { id?: string | null } | null;
} | null;

type DenialReason = "unauthorized" | "forbidden";
type Denied<T> = (reason: DenialReason) => T;

type AuthzDependencies = {
  getSession: () => Promise<AuthorizationSession>;
  findAdmin: (id: string) => Promise<{ id: string; role: string; isActive: boolean } | null>;
  findProject: (id: string) => Promise<{ ownerId: string | null } | null>;
  findBooking: (id: string) => Promise<{ adminId: string; project: { ownerId: string | null } } | null>;
};

/** Dependency-injected authorization helpers keep the rules easy to test. */
export function createAuthorizationHelpers(deps: AuthzDependencies) {
  async function requireActiveSession<T = never>(denied?: Denied<T>): Promise<AuthorizationActor | T> {
    const session = await deps.getSession();
    const id = session?.user?.id;
    if (!id) return reject("unauthorized", denied);

    // JWT role and active state can be stale. Always trust the current DB row.
    const admin = await deps.findAdmin(id);
    if (!admin || !admin.isActive) return reject("unauthorized", denied);
    if (admin.role !== "admin" && admin.role !== "super_admin" && admin.role !== "org_owner") {
      return reject("unauthorized", denied);
    }
    return { id: admin.id, role: admin.role };
  }

  function requireRole<T = never>(
    actor: AuthorizationActor,
    roles: readonly AuthorizationActor["role"][],
    denied?: Denied<T>
  ): AuthorizationActor | T {
    if (!roles.includes(actor.role)) return reject("forbidden", denied);
    return actor;
  }

  async function requireProjectAccess<T = never>(
    actor: AuthorizationActor,
    projectId: string,
    denied?: Denied<T>
  ): Promise<AuthorizationActor | T> {
    const project = await deps.findProject(projectId);
    if (!project || !canManageProject(actor, project)) return reject("forbidden", denied);
    return actor;
  }

  async function requireBookingAccess<T = never>(
    actor: AuthorizationActor,
    bookingId: string,
    denied?: Denied<T>
  ): Promise<AuthorizationActor | T> {
    const booking = await deps.findBooking(bookingId);
    if (!booking || (
      actor.role !== "org_owner" &&
      booking.adminId !== actor.id &&
      booking.project.ownerId !== actor.id
    )) return reject("forbidden", denied);
    return actor;
  }

  return { requireActiveSession, requireRole, requireProjectAccess, requireBookingAccess };
}

function reject<T>(reason: DenialReason, denied?: Denied<T>): never | T {
  if (denied) return denied(reason);
  throw new Error(reason === "unauthorized" ? "Unauthorized" : "Forbidden");
}

const authorizationHelpers = createAuthorizationHelpers({
  getSession: async () => await auth() as AuthorizationSession,
  findAdmin: async (id) => db.admin.findUnique({ where: { id }, select: { id: true, role: true, isActive: true } }),
  findProject: async (id) => db.project.findUnique({ where: { id }, select: { ownerId: true } }),
  findBooking: async (id) => db.booking.findUnique({
    where: { id },
    select: { adminId: true, project: { select: { ownerId: true } } },
  }),
});

export const requireActiveSession = authorizationHelpers.requireActiveSession;
export const requireRole = authorizationHelpers.requireRole;
export const requireProjectAccess = authorizationHelpers.requireProjectAccess;
export const requireBookingAccess = authorizationHelpers.requireBookingAccess;

export function canViewAllProjects(role: string): boolean {
  return role === "org_owner";
}

export function getScopeFilter(user: RoleInfo): { ownerId?: string } {
  if (canViewAllProjects(user.role)) return {};
  return { ownerId: user.id };
}

export function isOrgOwner(role: string): boolean {
  return role === "org_owner";
}

export function isSuperAdmin(role: string): boolean {
  return role === "super_admin";
}

export function isAdmin(role: string): boolean {
  return role === "admin";
}

export function canManageProject(
  user: RoleInfo,
  project: { ownerId: string | null }
): boolean {
  if (canViewAllProjects(user.role)) return true;
  return project.ownerId === user.id;
}
