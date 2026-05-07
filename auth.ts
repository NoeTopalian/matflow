import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { shouldRefreshBrand } from "@/lib/brand-refresh";
import { readPendingTenantSlug, clearPendingTenantSlug } from "@/lib/pending-tenant-cookie";
import { isTestingMode } from "@/lib/testing-mode";
import { recordLoginEvent } from "@/lib/login-event";
import { readImpersonationCookie } from "@/lib/impersonation";

// Resolve the public app URL once for outbound links (e.g. the disown-login
// link in P1.6 emails). Falls back to a sensible string in dev so the helper
// never throws — emails sent without NEXTAUTH_URL are clearly broken anyway.
function appUrl(reqHeaders?: Headers): string {
  const env = process.env.NEXTAUTH_URL ?? process.env.APP_URL;
  if (env) return env;
  if (reqHeaders) {
    const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
    const host = reqHeaders.get("host");
    if (host) return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}

// P1.5: Google OAuth as an alternative login. Disabled by default so the
// existing credentials/magic-link flow keeps working until GCP credentials
// + ENABLE_GOOGLE_OAUTH=true are set. Tenant context is supplied by a
// signed `pendingTenantSlug` cookie set at the club-code step — Google
// itself never decides which gym you log into.
const GOOGLE_OAUTH_ENABLED =
  process.env.ENABLE_GOOGLE_OAUTH === "true" &&
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET;

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
  // Only warn on REAL production (Vercel main). Preview deployments run with
  // NODE_ENV=production but VERCEL_ENV=preview — TESTING_MODE is honoured there.
  if (process.env.VERCEL_ENV === "production" && process.env.TESTING_MODE === "true") {
    console.warn("[auth] TESTING_MODE=true ignored in production");
  }
  if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) throw new Error("NEXTAUTH_SECRET or AUTH_SECRET is required in production");
  if (!process.env.NEXTAUTH_URL)    console.warn("[auth] NEXTAUTH_URL not set — defaulting to Vercel deployment URL");

  // RESEND_FROM left at the resend.dev default lands every transactional
  // email (password reset, owner activation, payment failed, login alerts)
  // in spam. Loud-warn at boot so it's visible in Vercel logs the moment
  // the app starts.
  const resendFrom = process.env.RESEND_FROM ?? "";
  if (!resendFrom || /resend\.dev>?$/.test(resendFrom)) {
    console.warn(
      "[auth] RESEND_FROM is unset or still pointing at resend.dev — " +
      "transactional emails will be flagged as spam. " +
      "Verify a domain in Resend and set RESEND_FROM=\"MatFlow <noreply@your-domain>\".",
    );
  }
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

// Account lockout: stricter than rate-limit because rate-limit windows reset
// and let an attacker keep grinding. After this many *consecutive* failed
// password attempts, the account is locked for ACCOUNT_LOCKOUT_DURATION_MS.
// A successful login resets the counter.
const ACCOUNT_LOCKOUT_THRESHOLD = 10;
const ACCOUNT_LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour

class RateLimitedError extends Error {
  constructor() {
    super("Too many login attempts. Try again later.");
  }
}

class AccountLockedError extends Error {
  constructor() {
    super("This account is temporarily locked due to too many failed sign-in attempts. Try again later.");
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
    ...(GOOGLE_OAUTH_ENABLED
      ? [
          Google({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            // Force the account chooser so a previously-signed-in Google
            // account on a shared device can't silently grant access.
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
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
          // Pre-session lookup: caller has no JWT yet. Use bypass to fetch the
          // tenant by slug, then switch to tenant-scoped reads once we have id.
          const tenant = await withRlsBypass((tx) =>
            tx.tenant.findUnique({ where: { slug: tenantSlug } }),
          );
          if (!tenant) return null;
          // Reject login for suspended or soft-deleted tenants. The admin
          // hub Danger Zone sets these states; auth flow respects them.
          if (tenant.deletedAt !== null) return null;
          if (tenant.subscriptionStatus === "suspended") return null;

          // Sprint 4-A US-404: parallelise user + member lookups. Most logins are
          // members, so the previous "find user, then maybe find member" was always
          // a 2-roundtrip path for the common case. One extra read when staff logs in
          // is a worthwhile trade for ~30-80ms saved on every member login.
          const [user, memberRowRaw] = await withTenantContext(tenant.id, (tx) =>
            Promise.all([
              tx.user.findUnique({
                where: { tenantId_email: { tenantId: tenant.id, email } },
              }),
              tx.member.findUnique({
                where: { tenantId_email: { tenantId: tenant.id, email } },
              }),
            ]),
          );
          const memberRow = !user ? memberRowRaw : null;

          // Account-lockout check: if the matched account is currently locked,
          // skip bcrypt entirely and reject. We still run bcrypt against DUMMY_HASH
          // below to keep the timing constant for locked / unlocked / non-existent
          // paths, then throw the lockout error.
          const subject: { id: string; lockedUntil: Date | null; failedLoginCount: number } | null =
            user
              ? { id: user.id, lockedUntil: user.lockedUntil, failedLoginCount: user.failedLoginCount }
              : memberRow
              ? { id: memberRow.id, lockedUntil: memberRow.lockedUntil, failedLoginCount: memberRow.failedLoginCount }
              : null;
          const isLocked = !!(subject?.lockedUntil && subject.lockedUntil > new Date());

          // Always run bcrypt to prevent email enumeration via timing differences.
          // Falls back to DUMMY_HASH when neither record exists — bcrypt still runs
          // but valid will be false, and we return null below.
          const targetHash =
            user?.passwordHash ??
            memberRow?.passwordHash ??
            DUMMY_HASH;

          const valid = await bcrypt.compare(password, targetHash);

          if (isLocked) throw new AccountLockedError();

          if (!valid) {
            // Increment failed-login count on the matched account; lock it if
            // we've crossed the threshold. Best-effort — failures here must not
            // block the login response (which is "null" for invalid creds).
            if (subject) {
              const newCount = subject.failedLoginCount + 1;
              const shouldLock = newCount >= ACCOUNT_LOCKOUT_THRESHOLD;
              const lockedUntil = shouldLock ? new Date(Date.now() + ACCOUNT_LOCKOUT_DURATION_MS) : null;
              try {
                await withTenantContext(tenant.id, async (tx) => {
                  if (user) {
                    await tx.user.update({
                      where: { id: user.id },
                      data: shouldLock
                        ? { failedLoginCount: 0, lockedUntil }
                        : { failedLoginCount: newCount },
                    });
                  } else if (memberRow) {
                    await tx.member.update({
                      where: { id: memberRow.id },
                      data: shouldLock
                        ? { failedLoginCount: 0, lockedUntil }
                        : { failedLoginCount: newCount },
                    });
                  }
                });
                if (shouldLock) {
                  // Audit so the owner sees the suspicious activity in the log.
                  const { logAudit } = await import("@/lib/audit-log");
                  await logAudit({
                    tenantId: tenant.id,
                    userId: user?.id ?? null,
                    action: "auth.account.locked",
                    entityType: user ? "User" : "Member",
                    entityId: subject.id,
                    metadata: { reason: "consecutive_failed_logins", threshold: ACCOUNT_LOCKOUT_THRESHOLD },
                  });
                }
              } catch { /* swallow — failed-count tracking is best-effort */ }
            }
            return null;
          }

          // Successful login — reset failed counter + clear any stale lock.
          if (subject && (subject.failedLoginCount > 0 || subject.lockedUntil)) {
            try {
              await withTenantContext(tenant.id, async (tx) => {
                if (user) {
                  await tx.user.update({
                    where: { id: user.id },
                    data: { failedLoginCount: 0, lockedUntil: null },
                  });
                } else if (memberRow) {
                  await tx.member.update({
                    where: { id: memberRow.id },
                    data: { failedLoginCount: 0, lockedUntil: null },
                  });
                }
              });
            } catch { /* swallow — best-effort */ }
          }

          if (user) {
            const role = normalizeRole(user.role);
            const isOwner = role === "owner";
            // P1.6: fire-and-forget new-device detection. Internal try/catch
            // means a DB blip or Resend outage cannot break the login response.
            void recordLoginEvent({
              subject: {
                kind: "user",
                id: user.id,
                email: user.email,
                tenantId: tenant.id,
                role,
                notifyOnNewLogin: user.notifyOnNewLogin,
              },
              ip,
              ua: request.headers.get("user-agent"),
              appUrl: appUrl(request.headers),
              gymName: tenant.name,
            });
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
              totpPending: !isTestingMode() && isOwner && user.totpEnabled === true,
              // 2FA-optional spec (2026-05-07): requireTotpSetup is no longer a
              // proxy.ts redirect gate — it now drives the dashboard banner only.
              // Computation stays so the banner has a stable signal for owners.
              requireTotpSetup: !isTestingMode() && isOwner && user.totpEnabled !== true,
              // 2FA-optional spec: ground-truth totpEnabled for the dashboard
              // banner (any role). Banner is shown when this is false.
              totpEnabled: user.totpEnabled,
            };
          }

          if (memberRow?.passwordHash) {
            void recordLoginEvent({
              subject: {
                kind: "member",
                id: memberRow.id,
                email: memberRow.email,
                tenantId: tenant.id,
                notifyOnNewLogin: memberRow.notifyOnNewLogin,
              },
              ip,
              ua: request.headers.get("user-agent"),
              appUrl: appUrl(request.headers),
              gymName: tenant.name,
            });
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
              // 2FA-optional spec (2026-05-07): mirror the User TOTP fields for
              // password-bearing members. totpPending fires the second-factor
              // /login/totp challenge when the member has enrolled.
              totpPending: !isTestingMode() && memberRow.totpEnabled === true,
              totpEnabled: memberRow.totpEnabled,
            };
          }

          // Reached only when DUMMY_HASH was used (no matching account)
          return null;
        } catch (err) {
          if (err instanceof RateLimitedError || err instanceof AccountLockedError) throw err;
          // DB unavailable — DEMO_MODE fallback is dev-only. Wrapping the early
          // return on NODE_ENV first lets bundlers (Next.js + terser) eliminate
          // the demo credential map from production builds entirely. The
          // existing prod-runtime guard above (line ~48) prevents DEMO_MODE
          // from ever being honoured at runtime in prod, but keeping the
          // credentials out of the shipped JS removes the optics concern in
          // any code-review-grade diligence.
          if (process.env.NODE_ENV === "production") return null;
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
    // P1.5: gate Google OAuth. The Credentials provider's authorize() already
    // returns its own user object; this only fires substantive logic on the
    // OAuth path.
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;

      // Google must have verified the email — without this, anyone who
      // controls a Google account with an unverified email matching a real
      // member could log in.
      if (!(profile as { email_verified?: boolean })?.email_verified) {
        return "/login?error=GoogleEmailUnverified";
      }

      const slug = await readPendingTenantSlug();
      if (!slug) return "/login?error=NoTenantContext";

      const email = user.email?.toLowerCase().trim();
      if (!email) return "/login?error=NoTenantContext";

      const tenant = await withRlsBypass((tx) =>
        tx.tenant.findUnique({ where: { slug } }),
      );
      if (!tenant) return "/login?error=NoTenantContext";

      const [dbUser, memberRow] = await withTenantContext(tenant.id, (tx) =>
        Promise.all([
          tx.user.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          }),
          tx.member.findUnique({
            where: { tenantId_email: { tenantId: tenant.id, email } },
          }),
        ]),
      );
      // No auto-provisioning. Only existing accounts can use Google login.
      if (!dbUser && !memberRow) return "/login?error=NoAccountForGym";

      // Hydrate the `user` object so the jwt() callback below populates the
      // token with the same shape as the Credentials path produces.
      const member = !dbUser ? memberRow : null;
      const isOwner = !!dbUser && normalizeRole(dbUser.role) === "owner";
      Object.assign(user, dbUser
        ? {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
            sessionVersion: dbUser.sessionVersion,
            tenantId: dbUser.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
            totpPending: !isTestingMode() && isOwner && dbUser.totpEnabled === true,
            requireTotpSetup: !isTestingMode() && isOwner && dbUser.totpEnabled !== true,
            totpEnabled: dbUser.totpEnabled,
          }
        : {
            id: member!.id,
            email: member!.email,
            name: member!.name,
            role: "member",
            sessionVersion: member!.sessionVersion,
            tenantId: member!.tenantId,
            tenantSlug: tenant.slug,
            tenantName: tenant.name,
            primaryColor: tenant.primaryColor,
            secondaryColor: tenant.secondaryColor,
            textColor: tenant.textColor,
            memberId: member!.id,
            totpPending: !isTestingMode() && member!.totpEnabled === true,
            totpEnabled: member!.totpEnabled,
          });

      // P1.6: new-device detection on the OAuth path too. Fire-and-forget;
      // signIn() doesn't get a Request, so we read headers via next/headers.
      try {
        const { headers } = await import("next/headers");
        const h = await headers();
        const fwd = h.get("x-forwarded-for");
        const ip = fwd ? fwd.split(",")[0].trim() : (h.get("x-real-ip") ?? "unknown");
        const ua = h.get("user-agent");
        const subjectArgs = dbUser
          ? {
              kind: "user" as const,
              id: dbUser.id,
              email: dbUser.email,
              tenantId: tenant.id,
              role: normalizeRole(dbUser.role),
              notifyOnNewLogin: dbUser.notifyOnNewLogin,
            }
          : {
              kind: "member" as const,
              id: memberRow!.id,
              email: memberRow!.email,
              tenantId: tenant.id,
              notifyOnNewLogin: memberRow!.notifyOnNewLogin,
            };
        void recordLoginEvent({
          subject: subjectArgs,
          ip,
          ua,
          appUrl: appUrl(h),
          gymName: tenant.name,
        });
      } catch { /* best-effort */ }

      // Tenant decision is final — clear the cookie so it can't be reused.
      await clearPendingTenantSlug();
      return true;
    },
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
        token.totpEnabled = (user as any).totpEnabled ?? false;
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

      // Super-admin impersonation override.
      // If a valid `matflow_impersonation` cookie is present, atomically swap
      // the token to the target user's identity. Subsequent gates (sessionVersion
      // check, brand refresh, TOTP enforcement in proxy.ts) then operate on the
      // TARGET user — which is correct: if the target gets disowned mid-session,
      // the impersonation dies. Bypasses TOTP because the admin secret authorised
      // the access at start-time.
      if (process.env.NEXT_RUNTIME !== "edge") {
        try {
          const imp = await readImpersonationCookie();
          if (imp) {
            const target = await prisma.user.findUnique({
              where: { id: imp.targetUserId },
              select: {
                id: true, role: true, sessionVersion: true, tenantId: true,
                tenant: {
                  select: {
                    name: true, slug: true,
                    primaryColor: true, secondaryColor: true, textColor: true,
                  },
                },
              },
            });
            if (target && target.tenantId === imp.targetTenantId) {
              token.id = target.id;
              token.tenantId = target.tenantId;
              token.tenantSlug = target.tenant.slug;
              token.tenantName = target.tenant.name;
              token.primaryColor = target.tenant.primaryColor;
              token.secondaryColor = target.tenant.secondaryColor;
              token.textColor = target.tenant.textColor;
              token.role = normalizeRole(target.role);
              token.sessionVersion = target.sessionVersion;
              token.memberId = null;
              token.totpPending = false;
              token.requireTotpSetup = false;
              // Impersonation suppresses the recommend-2FA banner — operator
              // is acting on someone else's account; nudging them to enrol the
              // target's authenticator would be confusing.
              token.totpEnabled = true;
              token.brandFetchedAt = Date.now();
              (token as Record<string, unknown>).impersonatedBy = imp.adminUserId;
              (token as Record<string, unknown>).impersonationReason = imp.reason;
            }
          }
        } catch { /* impersonation override best-effort — don't break the JWT path */ }
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
      session.user.totpEnabled = (token.totpEnabled as boolean) ?? false;
      // Impersonation context, propagated from jwt() override above.
      const impersonatedBy = (token as Record<string, unknown>).impersonatedBy;
      const impersonationReason = (token as Record<string, unknown>).impersonationReason;
      if (typeof impersonatedBy === "string") {
        (session.user as unknown as Record<string, unknown>).impersonatedBy = impersonatedBy;
        (session.user as unknown as Record<string, unknown>).impersonationReason =
          typeof impersonationReason === "string" ? impersonationReason : null;
      }
      return session;
    },
  },
});
