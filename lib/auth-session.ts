import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

type AdminReader = {
  admin: {
    findUnique(args: {
      where: { id: string };
      select: { role: true; isActive: true };
    }): Promise<{ role: string; isActive: boolean } | null>;
  };
};

/** Re-read authorization claims from the Admin row for every Node request. */
export async function refreshActiveAdminToken<T extends JWT>(
  token: T,
  reader: AdminReader
): Promise<T | null> {
  if (!token.sub) return null;
  const admin = await reader.admin.findUnique({
    where: { id: token.sub },
    select: { role: true, isActive: true },
  });
  if (!admin || !admin.isActive) return null;
  return { ...token, role: admin.role, isActive: true } as T;
}

/** Omit the session entirely unless the refreshed JWT identifies an active admin. */
export function projectActiveAdminSession(
  session: Session,
  token: JWT
): (Session & { user: NonNullable<Session["user"]> & { id: string; role: string; accountType: string; isActive: true } }) | null {
  if (!token.sub || token.isActive !== true || typeof token.role !== "string") return null;
  if (!session.user) return null;
  return {
    ...session,
    user: {
      ...session.user,
      id: token.sub,
      role: token.role,
      accountType: typeof token.accountType === "string" ? token.accountType : "unknown",
      isActive: true,
    },
  };
}
