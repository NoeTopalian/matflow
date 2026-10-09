// SEC-012 / AH-G7 against a REAL database (security campaign lane A, 9 Oct
// 2026). Neon TEST branch only, through the guarded runners (owner role and
// matflow_app with RLS enforced).
//
// The unit file (tests/unit/sec-a-revocation-fail-closed.test.ts) feeds the
// callbacks the errors a driver reports. Here the errors are REAL: the
// revocation lookup runs on the real pool inside the real withRlsBypass, and
// the fault is injected into that same transaction by the database itself —
//   timeout:  SET LOCAL statement_timeout + pg_sleep → 57014 from the server;
//   connloss: pg_terminate_backend(pg_backend_pid()) → the server drops the
//             connection mid-transaction.
// Both are one-shot (the next lookup is healthy) and SET LOCAL only (a session
// SET through the pooler leaks to other clients — project memory). The real
// jwt()/session() callbacks of auth.ts decide; the real logout-all route
// (a protected mutation) and members GET (a protected read) are then driven
// with the session that produced. Positive controls on the same rows.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a-revocation-db-test-secret-0123456789abcdef";
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
// The real withRlsBypass, with a one-shot fault injected INTO the same
// transaction by the database itself.
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
const STAMP = `secA-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;

async function sessionAction(token: Record<string, unknown>) {
  if (!h.jwt) await import("@/auth");
  const t = (await h.jwt!({ token })) as Record<string, unknown> | null;
  // jwt() → null: revoked (the cookie is cleared). An unknown verdict keeps the
  // token, marked for revalidation (SF-44, lane A2): session() then carries no
  // user, and the exported auth() returns null for it.
  if (t === null) return { session: null as null | { user?: Record<string, unknown> } };
  if (typeof t.revalidateSince === "number") return { session: null as null | { user?: Record<string, unknown> }, marked: true };
  const session = (await h.session!({
    session: { user: { name: t.name, email: t.email }, expires: new Date(Date.now() + 3600_000).toISOString() },
    token: t,
  })) as { user?: Record<string, unknown> };
  return { session };
}

describe.skipIf(!HAS_DB)("SEC-012 on Postgres: an uncheckable session is refused, never admitted", () => {
  const ids = { tenant: "", slug: "", coach: "", member: "" };
  const coachToken = () => ({
    id: ids.coach, role: "coach", tenantId: ids.tenant, tenantSlug: ids.slug, tenantName: "secA club",
    sessionVersion: 0, memberId: null, mustChangePassword: false, totpPending: false, name: "secA Coach",
  });
  const memberToken = () => ({
    id: ids.member, role: "member", tenantId: ids.tenant, tenantSlug: ids.slug, tenantName: "secA club",
    sessionVersion: 0, memberId: ids.member, totpPending: false, name: "secA Member",
  });
  const coachVersion = async () =>
    (await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.coach }, select: { sessionVersion: true } }))).sessionVersion;

  async function logoutAll(session: unknown) {
    h.current = session;
    const { POST } = await import("@/app/api/auth/logout-all/route");
    return POST(new Request("http://localhost/api/auth/logout-all", { method: "POST" }));
  }
  async function membersList(session: unknown) {
    h.current = session;
    const { GET } = await import("@/app/api/members/route");
    const res = await GET(new Request("http://localhost/api/members"));
    const text = await res.text();
    return { status: res.status, text };
  }

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      ids.coach = (await tx.user.create({ data: { tenantId: t.id, email: E("coach"), name: "secA Coach", role: "coach", passwordHash: "synthetic-not-a-hash" } })).id;
      ids.member = (await tx.member.create({ data: { tenantId: t.id, email: E("member"), name: "secA Member Canary", passwordHash: "synthetic-not-a-hash" } })).id;
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

  it("positive control: a healthy check admits; the protected read returns data and the mutation writes", async () => {
    const r = await sessionAction(coachToken());
    expect(r.session?.user?.id).toBe(ids.coach);
    const list = await membersList(r.session);
    expect(list.status).toBe(200);
    expect(list.text).toContain("secA Member Canary");
  });

  for (const fault of ["timeout", "connloss"] as const) {
    it(`a real ${fault} during the revocation lookup: request refused, no data, no write; next request admitted`, async () => {
      const before = await coachVersion();
      const fired = h.faultsFired;
      h.fault = fault;
      const errSpy = vi.spyOn(console, "error");
      const r = await sessionAction(coachToken());
      expect(h.faultsFired, "the fault was injected into the revocation lookup").toBe(fired + 1);
      // The error the revocation check reported is the SERVER's: 57014 (statement
      // timeout) or 57P01 (backend terminated) — not a mock.
      const reported = JSON.stringify(errSpy.mock.calls);
      errSpy.mockRestore();
      expect(reported).toContain("session-revocation check failed");
      expect(reported).toContain(fault === "timeout" ? "57014" : "57P01");
      expect(r.session, "auth() is null: refused like a signed-out caller").toBeNull();

      const list = await membersList(r.session);
      expect(list.status).toBe(401);
      expect(list.text).not.toContain("secA Member Canary");
      const res = await logoutAll(r.session);
      expect(res.status).toBe(401);
      expect(await coachVersion(), "no protected write happened").toBe(before);

      // The next request (same cookie), with the database healthy again, is admitted.
      const next = await sessionAction(coachToken());
      expect(next.session?.user?.id).toBe(ids.coach);
    }, 60_000);
  }

  it("a member session fails closed the same way (real connection loss)", async () => {
    h.fault = "connloss";
    const r = await sessionAction(memberToken());
    expect(r.session).toBeNull();
    expect((await sessionAction(memberToken())).session?.user?.id, "positive control").toBe(ids.member);
  }, 60_000);

  it("a revoked session stays revoked (version moved)", async () => {
    const ok = await sessionAction(coachToken());
    const res = await logoutAll(ok.session);
    expect(res.status).toBe(200);
    expect(await coachVersion()).toBe(1);
    expect((await sessionAction(coachToken())).session).toBeNull();
  }, 60_000);

  it("the pool is healthy afterwards (no poisoned connection left behind)", async () => {
    const rows = await prisma.$queryRawUnsafe<{ ok: number }[]>("SELECT 1 AS ok");
    expect(Number(rows[0].ok)).toBe(1);
  });
});
