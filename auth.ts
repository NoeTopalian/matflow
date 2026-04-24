import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";

// Production runtime guards (skipped during `next build` page-data collection)
if (
  process.env.NODE_ENV === "production" &&
  process.env.NEXT_PHASE !== "phase-production-build"
) {
  if (process.env.DEMO_MODE === "true") {
    throw new Error("DEMO_MODE must not be enabled in production");
  }
  if (!process.env.NEXTAUTH_SECRET) throw new Error("NEXTAUTH_SECRET is required in production");
  if (!process.env.NEXTAUTH_URL)    throw new Error("NEXTAUTH_URL is required in production");
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(1),
});

function normalizeRole(r: unknown): string {
  return (typeof r === "string" ? r : "").toLowerCase().trim();
}

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
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password, tenantSlug } = parsed.data;

        // Rate limit by tenant+email (5 attempts / 15 min)
        const rlKey = `login:${tenantSlug}:${email.toLowerCase().trim()}`;
        const rl = checkRateLimit(rlKey, LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS);
        if (!rl.allowed) throw new RateLimitedError();

        try {
          const tenant = await prisma.tenant.findUnique({
            where: { slug: tenantSlug },
          });
          if (!tenant) return null;

          // Try staff (User model) first
          const user = await prisma.user.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          });
          if (user) {
            const valid = await bcrypt.compare(password, user.passwordHash);
            if (!valid) return null;
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
            };
          }

          // Try member (Member model) — member portal login
          const member = await prisma.member.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          });
          if (!member || !member.passwordHash) return null;

          const validMember = await bcrypt.compare(password, member.passwordHash);
          if (!validMember) return null;

          return {
            id: member.id,
            email: member.email,
            name: member.name,
            role: "member",
            sessionVersion: member.sessionVersion,
            tenantId: member.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
            memberId: member.id,
          };
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
      if (token.id && token.tenantId && token.tenantId !== "demo-tenant") {
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
            // Invalidated — wipe identifying fields
            return {};
          }
        } catch { /* DB transient — keep token */ }
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
      return session;
    },
  },
});
