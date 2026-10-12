// SF-44 against a REAL database, through the REAL proxy.ts and the REAL
// next-auth wrapper (security campaign iteration 2, lane A2, 9 Oct 2026).
// Neon TEST branch only, both roles through the guarded runners. Needs
// next-auth inlined by vitest (server.deps.inline: ["next-auth", "@auth/core"]);
// lane A2 proposes that line for vitest.config.ts.
//
// The faults are the database's own, injected one-shot into the revocation
// lookup's transaction (same technique as sec-a-revocation-fail-closed-db):
//   timeout:  SET LOCAL statement_timeout + pg_sleep  → 57014 from the server;
//   connloss: pg_terminate_backend(pg_backend_pid())  → 57P01, connection gone.
// "Partial outage": only the revocation read fails; other reads on the same
// pool succeed at the same moment, and the request is still refused.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "sec-a2-outage-proxy-db-secret-0123456789abcdef0123";
  process.env.AUTH_TRUST_HOST = "true";
  return { fault: null as null | "timeout" | "connloss", faultsFired: 0 };
});

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/impersonation", () => ({
  resolveActiveImpersonation: async () => null,
  hasImpersonationCookie: async () => false,
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
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

import { withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const COOKIE = "__Secure-authjs.session-token";

type Proxy = (req: unknown, ev?: unknown) => Promise<Response>;
let proxy: Proxy;

function sessionCookie(res: Response): { kind: "absent" } | { kind: "cleared" } | { kind: "set"; value: string } {
  const sc = res.headers.getSetCookie().filter((c) => c.startsWith(`${COOKIE}=`));
  if (sc.length === 0) return { kind: "absent" };
  if (sc.some((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c))) return { kind: "cleared" };
  return { kind: "set", value: sc[0].split(";")[0].slice(COOKIE.length + 1) };
}
async function decodeCookie(value: string) {
  const { decode } = await import("next-auth/jwt");
  return (await decode({ salt: COOKIE, secret: process.env.AUTH_SECRET!, token: value })) as Record<string, unknown> | null;
}

describe.skipIf(!HAS_DB)("SF-44 on Postgres through the real proxy: unknown → retryable 503, cookie kept; revoked → cleared", () => {
  const ids = { tenant: "", slug: "", coach: "", member: "" };

  async function mint(kind: "coach" | "member", extra: Record<string, unknown> = {}) {
    const { encode } = await import("next-auth/jwt");
    const base =
      kind === "coach"
        ? { id: ids.coach, role: "coach", memberId: null, name: "secA2 Coach" }
        : { id: ids.member, role: "member", memberId: ids.member, name: "secA2 Member" };
    return encode({
      salt: COOKIE,
      secret: process.env.AUTH_SECRET!,
      token: {
        ...base, tenantId: ids.tenant, tenantSlug: ids.slug, tenantName: "secA2 club", sessionVersion: 0,
        mustChangePassword: false, totpPending: false, requireTotpSetup: false, totpEnabled: false,
        brandFetchedAt: Date.now(), ...extra,
      },
    });
  }
  async function hit(path: string, token: string, method = "GET") {
    const { NextRequest } = await import("next/server");
    return proxy(new NextRequest(`https://localhost:3999${path}`, { method, headers: { cookie: `${COOKIE}=${token}` } }), {});
  }

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      ids.coach = (await tx.user.create({ data: { tenantId: t.id, email: E("coach"), name: "secA2 Coach", role: "coach", passwordHash: "synthetic-not-a-hash" } })).id;
      ids.member = (await tx.member.create({ data: { tenantId: t.id, email: E("member"), name: "secA2 Member Canary", passwordHash: "synthetic-not-a-hash" } })).id;
    });
    proxy = (await import("../../proxy")).default as never;
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

  it("positive control: a healthy check passes the proxy and refreshes (not clears) the cookie", async () => {
    const res = await hit("/api/members", await mint("coach"));
    expect(res.status).toBe(200);
    expect(sessionCookie(res).kind).toBe("set");
  }, 60_000);

  for (const fault of ["timeout", "connloss"] as const) {
    it(`real ${fault} in the revocation read (partial outage): 503 + Retry-After, cookie kept and marked; same cookie admitted after restoration`, async () => {
      const fired = h.faultsFired;
      h.fault = fault;
      const errSpy = vi.spyOn(console, "error");
      const res = await hit("/api/members", await mint("coach"));
      const reported = JSON.stringify(errSpy.mock.calls);
      errSpy.mockRestore();
      expect(h.faultsFired, "the fault hit the revocation lookup").toBe(fired + 1);
      expect(reported).toContain(fault === "timeout" ? "57014" : "57P01");
      // Partial outage: the rest of the database answers at this moment.
      const canary = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: ids.member }, select: { name: true } }));
      expect(canary?.name, "other reads succeed").toBe("secA2 Member Canary");

      expect(res.status).toBe(503);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await res.text()).not.toContain("secA2 Member Canary");
      const c = sessionCookie(res);
      expect(c.kind, "not signed out by a dependency failure").toBe("set");
      if (c.kind !== "set") return;
      expect(typeof (await decodeCookie(c.value))?.revalidateSince).toBe("number");

      const again = await hit("/api/members", c.value);
      expect(again.status, "next request revalidated against the restored database").toBe(200);
      const c2 = sessionCookie(again);
      expect(c2.kind).toBe("set");
      if (c2.kind === "set") expect((await decodeCookie(c2.value))?.revalidateSince).toBeUndefined();
    }, 60_000);
  }

  it("page request during a real connection loss: 503 page, not a redirect to /login, cookie kept", async () => {
    h.fault = "connloss";
    const res = await hit("/dashboard", await mint("coach"));
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(sessionCookie(res).kind).toBe("set");
  }, 60_000);

  it("member session, real timeout: 503, cookie kept; positive control afterwards", async () => {
    h.fault = "timeout";
    const res = await hit("/api/member/me", await mint("member"));
    expect(res.status).toBe(503);
    expect(sessionCookie(res).kind).toBe("set");
    const ok = await hit("/api/member/me", await mint("member"));
    expect(ok.status).toBe(200);
  }, 60_000);

  it("revoked during the outage: refused while unprovable (503, kept), cleared once the database proves it", async () => {
    h.fault = "connloss";
    const res = await hit("/api/members", await mint("coach"));
    expect(res.status).toBe(503);
    const c = sessionCookie(res);
    expect(c.kind).toBe("set");
    if (c.kind !== "set") return;
    // "Log out everywhere" lands while the user's browser is still retrying.
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.coach }, data: { sessionVersion: { increment: 1 } } }));
    const after = await hit("/api/members", c.value);
    expect(after.status).toBe(401);
    expect(sessionCookie(after).kind).toBe("cleared");
    // And a fresh token at the old version is refused and cleared outright.
    const stale = await hit("/api/members", await mint("coach"));
    expect(stale.status).toBe(401);
    expect(sessionCookie(stale).kind).toBe("cleared");
  }, 60_000);
});
