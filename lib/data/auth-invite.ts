import { db } from "@/lib/db";
import { AdminPrismaAdapter } from "@/lib/auth-adapter";

export type AzureAccountLinkInput = {
  expectedTenantId: string | undefined;
  tenantId: unknown;
  email: string | null | undefined;
  providerAccountId: string | undefined;
  account: Record<string, unknown>;
};

export type AzureAccountLinkResult =
  | { ok: true; adminId: string; linkedNow: boolean }
  | { ok: false; reason: "tenant_mismatch" | "invalid_identity" | "uninvited" | "deactivated" | "admin_already_linked" | "identity_linked_to_other_admin" };

/**
 * Validate and, only for an active invited Admin, explicitly attach a first
 * Azure identity. Subsequent lookups use provider + providerAccountId.
 * The database client is injectable so the same decision can be exercised
 * against the scratch database in tests.
 */
export async function linkAzureAdminAccount(
  input: AzureAccountLinkInput,
  client: typeof db = db
): Promise<AzureAccountLinkResult> {
  const expectedTid = input.expectedTenantId?.trim().toLowerCase();
  const actualTid = typeof input.tenantId === "string" ? input.tenantId.trim().toLowerCase() : "";
  if (!expectedTid || !actualTid || actualTid !== expectedTid) {
    return { ok: false, reason: "tenant_mismatch" };
  }

  const email = input.email?.trim().toLowerCase();
  const providerAccountId = input.providerAccountId?.trim();
  if (!providerAccountId) return { ok: false, reason: "invalid_identity" };

  const provider = "azure-ad";
  const identityWhere = { provider_providerAccountId: { provider, providerAccountId } };
  const decide = async (tx: any): Promise<AzureAccountLinkResult> => {
    const existingIdentity = await tx.account.findUnique({ where: identityWhere });
    if (existingIdentity) {
      const existingAdmin = await tx.admin.findUnique({
        where: { id: existingIdentity.userId },
        select: { id: true, isActive: true },
      });
      if (!existingAdmin?.isActive) return { ok: false, reason: "deactivated" };
      const emailOwner = email ? await tx.admin.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      }) : null;
      if (emailOwner && emailOwner.id !== existingAdmin.id) {
        return { ok: false, reason: "identity_linked_to_other_admin" };
      }
      return { ok: true, adminId: existingAdmin.id, linkedNow: false };
    }

    if (!email) return { ok: false, reason: "invalid_identity" };
    const invitedAdmin = await tx.admin.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, isActive: true },
    });
    if (!invitedAdmin) return { ok: false, reason: "uninvited" };
    if (!invitedAdmin.isActive) return { ok: false, reason: "deactivated" };

    const otherIdentity = await tx.account.findFirst({
      where: { userId: invitedAdmin.id, provider },
      select: { providerAccountId: true },
    });
    if (otherIdentity && otherIdentity.providerAccountId !== providerAccountId) {
      return { ok: false, reason: "admin_already_linked" };
    }

    await tx.account.create({
      data: {
        ...(input.account as any),
        provider,
        providerAccountId,
        userId: invitedAdmin.id,
        type: String(input.account.type ?? "oidc"),
      },
    });
    return { ok: true, adminId: invitedAdmin.id, linkedNow: true };
  };

  try {
    return await client.$transaction(decide, { isolationLevel: "Serializable" });
  } catch (error) {
    // Serializable transactions ensure simultaneous identities cannot both
    // become the first link for one Admin. Re-read after a uniqueness or
    // serialization conflict and accept only the already-committed same link.
    const code = (error as { code?: string })?.code;
    if (code !== "P2002" && code !== "P2034") throw error;
    const existingIdentity = await client.account.findUnique({ where: identityWhere });
    if (existingIdentity) {
      const existingAdmin = await client.admin.findUnique({
        where: { id: existingIdentity.userId },
        select: { id: true, isActive: true },
      });
      if (!existingAdmin?.isActive) return { ok: false, reason: "deactivated" };
      const emailOwner = email ? await client.admin.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      }) : null;
      return emailOwner && emailOwner.id !== existingAdmin.id
        ? { ok: false, reason: "identity_linked_to_other_admin" }
        : { ok: true, adminId: existingAdmin.id, linkedNow: false };
    }
    const invitedAdmin = await client.admin.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    const otherIdentity = invitedAdmin && await client.account.findFirst({
      where: { userId: invitedAdmin.id, provider },
      select: { providerAccountId: true },
    });
    if (otherIdentity) return { ok: false, reason: "admin_already_linked" };
    throw error;
  }
}

/**
 * Shared decision used by the NextAuth `signIn` callback: is this email an
 * invited admin who may sign in via Microsoft?
 *
 * An Admin row must already exist (case-insensitive email match). This is the
 * invite-gate: an uninvited Microsoft account is denied before Auth.js ever
 * creates/link-accounts a row.
 */
export async function isInvitedAdminEmail(email: string): Promise<boolean> {
  const adapter = AdminPrismaAdapter();
  let existing = await adapter.getUserByEmail(email);
  if (!existing) {
    existing = await db.admin.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
  }
  return !!existing;
}

export type SignInGate = { invited: boolean; deactivated: boolean };

/**
 * One-shot gate used by the Azure AD signIn callback: is this email an invited
 * admin, and (if so) has that account been soft-deactivated?
 *
 * Deactivated is a distinct outcome from "not invited": the person is a real,
 * known user hitting a real barrier, so the caller can show them an explicit
 * "account deactivated" message rather than the generic AccessDenied used for
 * unknown emails (which must stay generic to avoid leaking who's invited).
 */
export async function getAzureSignInGate(email: string): Promise<SignInGate> {
  const normalized = email.trim().toLowerCase();
  const admin = await db.admin.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" } },
    select: { id: true, email: true, isActive: true },
  });
  console.log(`[AUTH-DEBUG] getAzureSignInGate: normalized="${normalized}" found=${!!admin} adminId=${admin?.id ?? "null"} adminEmail=${admin?.email ?? "null"} isActive=${admin?.isActive ?? "null"}`);
  if (!admin) return { invited: false, deactivated: false };
  return { invited: true, deactivated: !admin.isActive };
}
