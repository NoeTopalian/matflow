import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantSlug: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: 365 * 24 * 60 * 60, // 1 year — permanent until manual logout
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

        // ── Demo bypass (no DB required) ─────────────────────────────
        const DEMO_USERS: Record<string, { name: string; role: string }> = {
          "owner@totalbjj.com":  { name: "Owner",      role: "owner"  },
          "coach@totalbjj.com":  { name: "Coach Mike", role: "coach"  },
          "admin@totalbjj.com":  { name: "Admin",      role: "admin"  },
        };
        if (tenantSlug === "totalbjj" && DEMO_USERS[email]) {
          const demo = DEMO_USERS[email];
          if (password !== "password123") return null;
          return {
            id: `demo-${email}`,
            email,
            name: demo.name,
            role: demo.role,
            tenantId: "demo-tenant",
            tenantSlug: "totalbjj",
            tenantName: "Total BJJ",
            primaryColor: "#3b82f6",
            secondaryColor: "#2563eb",
            textColor: "#ffffff",
          };
        }
        // ── Real DB auth ─────────────────────────────────────────────

        try {
          const tenant = await prisma.tenant.findUnique({
            where: { slug: tenantSlug },
          });
          if (!tenant) return null;

          const user = await prisma.user.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          });
          if (!user) return null;

          const valid = await bcrypt.compare(password, user.passwordHash);
          if (!valid) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            tenantId: user.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as any).role;
        token.tenantId = (user as any).tenantId;
        token.tenantSlug = (user as any).tenantSlug;
        token.tenantName = (user as any).tenantName;
        token.primaryColor = (user as any).primaryColor;
        token.secondaryColor = (user as any).secondaryColor;
        token.textColor = (user as any).textColor;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id as string;
      session.user.role = token.role as string;
      session.user.tenantId = token.tenantId as string;
      session.user.tenantSlug = token.tenantSlug as string;
      session.user.tenantName = token.tenantName as string;
      session.user.primaryColor = token.primaryColor as string;
      session.user.secondaryColor = token.secondaryColor as string;
      session.user.textColor = token.textColor as string;
      return session;
    },
  },
});
