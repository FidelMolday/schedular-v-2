import NextAuth from "next-auth";
import AzureAD from "next-auth/providers/azure-ad";
import Credentials from "next-auth/providers/credentials";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { headers } from "next/headers";
import { azureTenantIssuer, requireAzureTenantId } from "@/lib/azure-tenant";

const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const AZURE_AD_TENANT_ID = requireAzureTenantId(process.env.AZURE_AD_TENANT_ID);

let _adapter: ReturnType<typeof import("@/lib/auth-adapter").AdminPrismaAdapter> | null = null;

async function getDb() {
  const { db } = await import("@/lib/db");
  return db;
}

async function getAdapter() {
  if (!_adapter) {
    const { AdminPrismaAdapter } = await import("@/lib/auth-adapter");
    _adapter = AdminPrismaAdapter();
  }
  return _adapter;
}

async function refreshAccessToken(token: any) {
  if (!token.accountId) return { ...token, error: "RefreshAccessTokenError" };

  const { refreshAzureToken } = await import("@/lib/graph/refresh");
  const updated = await refreshAzureToken(token.accountId);
  if (!updated) return { ...token, error: "RefreshAccessTokenError" };

  const db = await getDb();
  const account = await db.account.findUnique({ where: { id: token.accountId } });

  return {
    ...token,
    access_token: updated,
    expires_at: account?.expires_at ?? token.expires_at,
    refresh_token: account?.refresh_token ?? token.refresh_token,
    error: undefined,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: {
    async createUser(user) {
      const a = await getAdapter();
      return a.createUser(user);
    },
    async getUser(id) {
      const a = await getAdapter();
      return a.getUser(id);
    },
    async getUserByEmail(email) {
      const a = await getAdapter();
      return a.getUserByEmail(email);
    },
    async getUserByAccount(provider_providerAccountId) {
      const a = await getAdapter();
      return a.getUserByAccount(provider_providerAccountId);
    },
    async updateUser(user) {
      const a = await getAdapter();
      return a.updateUser(user);
    },
    async deleteUser(userId) {
      const a = await getAdapter();
      return a.deleteUser(userId);
    },
    async linkAccount(account) {
      const a = await getAdapter();
      return a.linkAccount(account);
    },
    async unlinkAccount(provider_providerAccountId) {
      const a = await getAdapter();
      return a.unlinkAccount(provider_providerAccountId);
    },
    async createSession(session) {
      const a = await getAdapter();
      return a.createSession(session);
    },
    async getSessionAndUser(sessionToken) {
      const a = await getAdapter();
      return a.getSessionAndUser(sessionToken);
    },
    async updateSession(session) {
      const a = await getAdapter();
      return a.updateSession(session);
    },
    async deleteSession(sessionToken) {
      const a = await getAdapter();
      return a.deleteSession(sessionToken);
    },
    async getAccount(providerAccountId, provider) {
      const a = await getAdapter();
      return a.getAccount(providerAccountId, provider);
    },
  },
  providers: [
    AzureAD({
      clientId: process.env.AZURE_AD_CLIENT_ID!,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
      issuer: azureTenantIssuer(AZURE_AD_TENANT_ID),
      authorization: {
        params: {
          scope: "openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/OnlineMeetings.ReadWrite",
        },
      },
      // Email matching is used only by linkAzureAdminAccount for the first
      // explicit link to an active invited row. Later sign-ins resolve by the
      // providerAccountId, and Auth.js email linking remains disabled.
      allowDangerousEmailAccountLinking: false,
    }),
    Credentials({
      name: "credentials",
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        // Rate-limit sign-in attempts: 10 per email+IP per 15 minutes.
        // Generous enough to avoid locking out real users who mistype,
        // strict enough to slow brute-force attacks.
        const hdrs = await headers();
        const ip = getClientIp(hdrs);
        const email = (credentials.email as string).toLowerCase().trim();
        if (!checkRateLimit(`signin:${email}:${ip}`, 10, 15 * 60 * 1000)) {
          return null;
        }

        const { verifyPassword } = await import("@/lib/password");
        const { db } = await import("@/lib/db");
        const admin = await db.admin.findUnique({ where: { email } });
        if (!admin || !admin.passwordHash) return null;
        // Deactivated accounts cannot sign in via any path. Same generic null
        // as a bad password so no account state is leaked to the attempt.
        if (!admin.isActive) return null;
        const valid = await verifyPassword(credentials.password as string, admin.passwordHash);
        if (!valid) return null;
        // super_admin/org_owner accounts must always sign in via Microsoft so
        // they get a live Graph token tied to that identity. Reject password
        // login even when the password itself is correct, using the SAME
        // generic null rejection so no role information is leaked.
        if (admin.role === "super_admin" || admin.role === "org_owner") return null;
        return { id: admin.id, name: admin.name, email: admin.email };
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    // Azure AD / Microsoft sign-in is invite-only: a Microsoft account is
    // only allowed to sign in if an Admin row already exists for that email.
    // Returning `false` makes @auth/core throw AccessDenied (which surfaces
    // as a redirect to pages.error) BEFORE the adapter's createUser/linkAccount
    // run, so an uninvited Microsoft account is never auto-provisioned.
    async signIn({ user, account, profile }: { user?: { email?: string | null } | null; account?: any; profile?: any }) {
      if (account?.provider === "azure-ad") {
        const email = (user?.email ?? "").trim();
        const { linkAzureAdminAccount } = await import("@/lib/data/auth-invite");
        const decision = await linkAzureAdminAccount({
          expectedTenantId: AZURE_AD_TENANT_ID,
          tenantId: profile?.tid,
          email,
          providerAccountId: account.providerAccountId,
          account,
        });
        if (!decision.ok) {
          if (decision.reason === "deactivated") return "/auth/error?error=account_deactivated";
          return false;
        }
        // A deactivated account is a real, known user hitting a real barrier —
        // redirect them to a specific message instead of the generic
        // AccessDenied (which is reserved for unknown emails to avoid leaking
        // who's invited).
        return true;
      }
      return true;
    },
    async jwt({ token, account, profile }) {
      if (account) {
        token.access_token = account.access_token;
        token.refresh_token = account.refresh_token;
        token.expires_at = account.expires_at;
        token.accountId = account.id;

        if (profile) {
          const tid = (profile as any).tid;
          const accountType = tid === CONSUMER_TENANT ? "personal" : "organizational";

          if (token.sub) {
            const db = await getDb();
            await db.admin.update({
              where: { id: token.sub },
              data: { accountType: accountType as any },
            });
            token.accountType = accountType;
          }
        }
      }

      // Role is re-read from the DB on every request (not cached in the JWT)
      // so role changes made server-side take effect without a full sign-out.
      // The token is only trusted for identity (sub); everything authorization-
      // relevant is refreshed here.
      //
      // The DB read runs only in the Node.js runtime. Middleware runs on the
      // Edge runtime where pg/node:crypto is unavailable, so it keeps trusting
      // the token's cached claims for its coarse redirect; every Node-runtime
      // page/API/action re-validates against the DB via this callback, so the
      // source of truth is always current wherever authorization is enforced.
      if (process.env.NEXT_RUNTIME !== "edge") {
        const db = await getDb();
        const { refreshActiveAdminToken } = await import("@/lib/auth-session");
        const refreshed = await refreshActiveAdminToken(token as any, db);
        if (!refreshed) return null;
        token = refreshed;
      }

      if (token.expires_at && Date.now() / 1000 > (token.expires_at as number)) {
        token = await refreshAccessToken(token);
      }

      return token;
    },
    async session({ session, token }) {
      const { projectActiveAdminSession } = await import("@/lib/auth-session");
      return projectActiveAdminSession(session, token as any) as any;
    },
  },
  trustHost: true,
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
});
