import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { shouldRefreshBrand } from "@/lib/brand-refresh";

// Pre-computed bcrypt hash used to keep response times constant on the
// user-not-found path, preventing email enumeration via timing differences.
const DUMMY_HASH = bcrypt.hashSync("constant-time-padding-only", 12);

// Production runtime guards (skipped during `next build` page-data collection)
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  if (process.env.DEMO_MODE === "true") {
    throw new Error("DEMO_MODE must not be enabled in production");
  }
  if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) throw new Error("NEXTAUTH_SECRET or AUTH_SECRET is required in production");
  if (!process.env.NEXTAUTH_URL)    console.warn("[auth] NEXTAUTH_URL not set — defaulting to Vercel deployment URL");
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(1),
});

function normalizeRole(r: unknown): string {
  return (typeof r === "string" ? r : "").toLowerCase().trim();
}

// LB-004 brand refresh helpers live in lib/brand-refresh.ts so vitest can
// import them without booting the NextAuth runtime.

const LOGIN_RATE_MAX = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

class RateLimitedError extends Error {
  constructor() {
    super("Too many login attempts. Try again later.");
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      async authorize(credentials, request) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password, tenantSlug } = parsed.data;

        // IP-based rate limit (30 attempts / 30 min) — global across all tenants
        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request.headers.get("x-real-ip") ??
          "unknown";
        // Sprint 4-A US-404: parallelise the two independent rate-limit checks.
        const rlKey = `login:${tenantSlug}:${email.toLowerCase().trim()}`;
        const [ipRl, rl] = await Promise.all([
          checkRateLimit(`login:ip:${ip}`, 30, 30 * 60 * 1000),
          checkRateLimit(rlKey, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS),
        ]);
        if (!ipRl.allowed) throw new RateLimitedError();
        if (!rl.allowed) throw new RateLimitedError();

        try {
          const tenant = await prisma.tenant.findUnique({
            where: { slug: tenantSlug },
          });
          if (!tenant) return null;

          // Sprint 4-A US-404: parallelise user + member lookups. Most logins are
          // members, so the previous "find user, then maybe find member" was always
          // a 2-roundtrip path for the common case. One extra read when staff logs in
          // is a worthwhile trade for ~30-80ms saved on every member login.
          const [user, memberRowRaw] = await Promise.all([
            prisma.user.findUnique({
              where: { tenantId_email: { tenantId: tenant.id, email } },
            }),
            prisma.member.findUnique({
              where: { tenantId_email: { tenantId: tenant.id, email } },
            }),
          ]);
          const memberRow = !user ? memberRowRaw : null;

          // Always run bcrypt to prevent email enumeration via timing differences.
          // Falls back to DUMMY_HASH when neither record exists — bcrypt still runs
          // but valid will be false, and we return null below.
          const targetHash =
            user?.passwordHash ??
            memberRow?.passwordHash ??
            DUMMY_HASH;

          const valid = await bcrypt.compare(password, targetHash);
          if (!valid) return null;

          if (user) {
            const role = normalizeRole(user.role);
            const isOwner = role === "owner";
            return {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              sessionVersion: user.sessionVersion,
              tenantId: user.tenantId,
              tenantSlug: tenant.slug,
              tenantName: tenant.name,
              primaryColor: tenant.primaryColor,
              secondaryColor: tenant.secondaryColor,
              textColor: tenant.textColor,
              totpPending: isOwner && user.totpEnabled === true,
              // Fix 4: mandatory TOTP for owner role. Owners who haven't enrolled
              // yet are gated to /login/totp/setup until they do.
              requireTotpSetup: isOwner && user.totpEnabled !== true,
            };
          }

          if (memberRow?.passwordHash) {
            return {
              id: memberRow.id,
              email: memberRow.email,
              name: memberRow.name,
              role: "member",
              sessionVersion: memberRow.sessionVersion,
              tenantId: memberRow.tenantId,
              tenantSlug: tenant.slug,
              tenantName: tenant.name,
              primaryColor: tenant.primaryColor,
              secondaryColor: tenant.secondaryColor,
              textColor: tenant.textColor,
              memberId: memberRow.id,
            };
          }

          // Reached only when DUMMY_HASH was used (no matching account)
          return null;
        } catch (err) {
          if (err instanceof RateLimitedError) throw err;
          // DB unavailable — only use demo fallback when DEMO_MODE=true is explicitly set
          if (process.env.DEMO_MODE !== "true") return null;

          const DEMO_USERS: Record<string, { name: string; role: string }> = {
            "owner@totalbjj.com":  { name: "Owner",      role: "owner" },
            "coach@totalbjj.com":  { name: "Coach Mike", role: "coach" },
            "admin@totalbjj.com":  { name: "Admin",      role: "admin" },
            "member@totalbjj.com": { name: "John Smith", role: "member" },
          };
          if (tenantSlug === "totalbjj" && DEMO_USERS[email] && password === "password123") {
            const demo = DEMO_USERS[email];
            return {
              id: `demo-${email}`,
              email,
              name: demo.name,
              role: demo.role,
              sessionVersion: 0,
              tenantId: "demo-tenant",
              tenantSlug: "totalbjj",
              tenantName: "Total BJJ",
              primaryColor: "#3b82f6",
              secondaryColor: "#2563eb",
              textColor: "#ffffff",
            };
          }
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = normalizeRole((user as any).role);
        token.sessionVersion = (user as any).sessionVersion ?? 0;
        token.tenantId = (user as any).tenantId;
        token.tenantSlug = (user as any).tenantSlug;
        token.tenantName = (user as any).tenantName;
        token.primaryColor = (user as any).primaryColor;
        token.secondaryColor = (user as any).secondaryColor;
        token.textColor = (user as any).textColor;
        token.memberId = (user as any).memberId ?? null;
        token.totpPending = (user as any).totpPending ?? false;
        token.requireTotpSetup = (user as any).requireTotpSetup ?? false;
        // LB-004: stamp brand-fetch timestamp so the periodic refresh below
        // knows when to re-query Tenant.* without forcing the user to log out.
        token.brandFetchedAt = Date.now();
        return token;
      }

      // Upgrade stale demo-tenant tokens to real DB ids on next request
      if (token.tenantId === "demo-tenant" && token.tenantSlug) {
        try {
          const tenant = await prisma.tenant.findUnique({
            where: { slug: token.tenantSlug as string },
          });
          if (tenant) {
            const dbUser = await prisma.user.findFirst({
              where: { tenantId: tenant.id, email: token.email as string },
            });
            if (dbUser) {
              token.id = dbUser.id;
              token.tenantId = tenant.id;
              token.tenantName = tenant.name;
              token.sessionVersion = dbUser.sessionVersion;
              token.primaryColor = tenant.primaryColor;
              token.secondaryColor = tenant.secondaryColor;
              token.textColor = tenant.textColor;
              token.memberId = null;
            }
          }
        } catch { /* DB still unavailable — keep demo token */ }
        return token;
      }

      // Non-user refresh: verify the token's sessionVersion still matches DB.
      // Mismatch = force sign-out (clear identity fields; session() returns no user).
      // Skip in Edge runtime (proxy.ts) — Prisma is Node-only; the layout's
      // auth() call (Node runtime) re-runs this callback and enforces the check.
      if (
        process.env.NEXT_RUNTIME !== "edge" &&
        token.id && token.tenantId && token.tenantId !== "demo-tenant"
      ) {
        try {
          const tokenMemberId = token.memberId as string | null;
          const currentVersion = tokenMemberId
            ? (await prisma.member.findUnique({
                where: { id: tokenMemberId },
                select: { sessionVersion: true },
              }))?.sessionVersion
            : (await prisma.user.findUnique({
                where: { id: token.id as string },
                select: { sessionVersion: true },
              }))?.sessionVersion;

          if (currentVersion !== undefined && currentVersion !== token.sessionVersion) {
            return null;
          }
        } catch { /* DB transient — keep token */ }

        // LB-004 (audit H10): refresh tenant branding every 5 minutes so
        // settings changes propagate without forcing users to log out (was
        // previously cached for the entire 30-day JWT lifetime).
        if (shouldRefreshBrand(token.brandFetchedAt as number | undefined)) {
          try {
            const tenant = await prisma.tenant.findUnique({
              where: { id: token.tenantId as string },
              select: { name: true, primaryColor: true, secondaryColor: true, textColor: true },
            });
            if (tenant) {
              token.tenantName = tenant.name;
              token.primaryColor = tenant.primaryColor;
              token.secondaryColor = tenant.secondaryColor;
              token.textColor = tenant.textColor;
              token.brandFetchedAt = Date.now();
            }
          } catch { /* DB transient — keep stale brand */ }
        }
      }

      return token;
    },
    session({ session, token }) {
      if (!token || !token.id) {
        // Token was invalidated (sessionVersion bumped) — return empty session.
        // NextAuth will treat this as "unauthenticated" on `auth()` calls.
        return { ...session, user: undefined as any };
      }
      session.user.id = token.id as string;
      session.user.role = (normalizeRole(token.role) as "owner" | "manager" | "coach" | "admin" | "member");
      session.user.tenantId = token.tenantId as string;
      session.user.tenantSlug = token.tenantSlug as string;
      session.user.tenantName = token.tenantName as string;
      session.user.primaryColor = token.primaryColor as string;
      session.user.secondaryColor = token.secondaryColor as string;
      session.user.textColor = token.textColor as string;
      session.user.memberId = (token.memberId as string) ?? undefined;
      session.user.totpPending = (token.totpPending as boolean) ?? false;
      session.user.requireTotpSetup = (token.requireTotpSetup as boolean) ?? false;
      return session;
    },
  },
});
