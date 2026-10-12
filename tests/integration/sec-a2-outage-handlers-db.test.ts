// SF-44 at the route-handler level against a REAL database (security campaign
// iteration 2, lane A2, 9 Oct 2026). Neon TEST branch only, both roles.
//
// Complements sec-a2-outage-proxy-db (which drives the real proxy.ts). Here the
// real jwt()/session() callbacks of auth.ts and the REAL exported auth() — the
// one every route handler and page calls — decide, with next-auth's own
// plumbing replaced by a capture (as in sec-a-revocation-fail-closed-db). The
// routes driven are a protected read (GET /api/members) and a protected
// mutation outside the proxy matcher (POST /api/auth/logout-all, which only
// its own auth() guards). Faults are the server's own (57014 / 57P01),
// one-shot, injected into the revocation lookup's transaction only.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a2-outage-handlers-db-secret-0123456789abcdef";
  return {
    jwt: undefined as undefined | Jwt,
    session: undefined as undefined | SessionCb,
    current: null as unknown,
    fault: null as null | "timeout" | "connloss",
    faultsFired: 0,
  };
});

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt; session?: SessionCb } }) => {
    h.jwt = config.callbacks?.jwt;
    h.session = config.callbacks?.session;
    return { handlers: {}, auth: async () => h.current, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/impersonation", () => ({
  resolveActiveImpersonation: async () => null,
  hasImpersonationCookie: async () => false,
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/prisma-tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prisma-tenant")>();
  return {
    ...real,
    withRlsBypass: (async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      const fault = h.fault;
      if (!fault) return real.withRlsBypass(fn as never, opts as never);
      h.fault = null;
      h.faultsFired++;
      return real.withRlsBypass(async (tx) => {
        const t = tx as unknown as { $executeRawUnsafe: (q: string) => Promise<unknown>; $queryRawUnsafe: (q: string) => Promise<unknown> };
        if (fault === "timeout") {
          await t.$executeRawUnsafe("SET LOCAL statement_timeout = '150ms'");
          await t.$queryRawUnsafe("SELECT pg_sleep(3)");
        } else {
          await t.$queryRawUnsafe("SELECT pg_terminate_backend(pg_backend_pid())");
        }
        return fn(tx);
      }, opts as never);
    }) as typeof real.withRlsBypass,
  };
});

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();

/** One request: jwt() on the cookie's claims, then session(); returns what Auth.js would re-issue. */
async function pass(token: Record<string, unknown>) {
  if (!h.jwt) await import("@/auth");
  const t = (await h.jwt!({ token: { ...token } })) as Record<string, unknown> | null;
  if (t === null) return { cookie: "cleared" as const, token: null, session: null as unknown };
  const session = await h.session!({
    session: { user: { name: t.name, email: t.email }, expires: new Date(Date.now() + 3600_000).toISOString() },
    token: t,
  });
  return { cookie: "kept" as const, token: t, session };
}

describe.skipIf(!HAS_DB)("SF-44 on Postgres, route handlers: unknown refuses via auth() = null with the cookie kept", () => {
  const ids = { tenant: "", slug: "", coach: "" };
  const coachToken = () => ({
    id: ids.coach, role: "coach", tenantId: ids.tenant, tenantSlug: ids.slug, tenantName: "secA2 club",
    sessionVersion: 0, memberId: null, mustChangePassword: false, totpPending: false, name: "secA2 Coach",
  });
  const coachVersion = async () =>
    (await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.coach }, select: { sessionVersion: true } }))).sessionVersion;

  async function membersList(session: unknown) {
    h.current = session;
    const { GET } = await import("@/app/api/members/route");
    const res = await GET(new Request("http://localhost/api/members"));
    return { status: res.status, text: await res.text() };
  }
  async function logoutAll(session: unknown) {
    h.current = session;
    const { POST } = await import("@/app/api/auth/logout-all/route");
    return (await POST(new Request("http://localhost/api/auth/logout-all", { method: "POST" }))).status;
  }

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      ids.coach = (await tx.user.create({ data: { tenantId: t.id, email: E("coach"), name: "secA2 Coach", role: "coach", passwordHash: "synthetic-not-a-hash" } })).id;
      await tx.member.create({ data: { tenantId: t.id, email: E("member"), name: "secA2 Member Canary", passwordHash: "synthetic-not-a-hash" } });
    });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.member.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      users: await tx.user.count({ where: { tenantId: ids.tenant } }),
      members: await tx.member.count({ where: { tenantId: ids.tenant } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, members: 0 });
  }, 120_000);

  it("positive control: healthy check → the read returns data", async () => {
    const r = await pass(coachToken());
    expect(r.cookie).toBe("kept");
    const list = await membersList(r.session);
    expect(list.status).toBe(200);
    expect(list.text).toContain("secA2 Member Canary");
  }, 60_000);

  for (const fault of ["timeout", "connloss"] as const) {
    it(`real ${fault}: token kept + marked (no sign-out), read and mutation refused with nothing written; next request admitted`, async () => {
      const before = await coachVersion();
      const fired = h.faultsFired;
      h.fault = fault;
      const r = await pass(coachToken());
      expect(h.faultsFired).toBe(fired + 1);
      expect(r.cookie, "a dependency failure does not clear the cookie").toBe("kept");
      expect(typeof r.token?.revalidateSince).toBe("number");
      expect((r.session as { user?: unknown }).user).toBeUndefined();
      expect((r.session as { authUnavailable?: unknown }).authUnavailable).toBe(true);

      const list = await membersList(r.session);
      expect(list.status).toBe(401);
      expect(list.text).not.toContain("secA2 Member Canary");
      expect(await logoutAll(r.session)).toBe(401);
      expect(await coachVersion(), "no protected write").toBe(before);

      const next = await pass(r.token!);
      expect(next.cookie).toBe("kept");
      expect(next.token?.revalidateSince, "marker removed only by a successful check").toBeUndefined();
      expect(((next.session as { user?: { id?: string } }).user)?.id).toBe(ids.coach);
    }, 60_000);
  }

  it("the marker survives a second failed pass and keeps refusing (no cached authority)", async () => {
    h.fault = "connloss";
    const r1 = await pass(coachToken());
    h.fault = "timeout";
    const r2 = await pass(r1.token!);
    expect(r2.cookie).toBe("kept");
    expect(r2.token?.revalidateSince).toBe(r1.token?.revalidateSince);
    expect((await membersList(r2.session)).status).toBe(401);
  }, 60_000);

  it("revoked during the outage: refused while unprovable, signed out (cleared) once provable", async () => {
    h.fault = "timeout";
    const r = await pass(coachToken());
    expect(r.cookie).toBe("kept");
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.coach }, data: { sessionVersion: { increment: 1 } } }));
    const after = await pass(r.token!);
    expect(after.cookie).toBe("cleared");
  }, 60_000);

  it("the pool is healthy afterwards", async () => {
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>("SELECT 1 AS ok");
    expect(Number(rows[0].ok)).toBe(1);
  });
});
