// SF-37 against a REAL database (security campaign iteration 2, lane A2,
// 9 Oct 2026). Neon TEST branch only, both roles through the guarded runners.
//
// (1) The two second-factor verify routes read the half-signed-in token with
//     getToken() (decode only — auth.ts jwt() never runs), so a token revoked
//     after the password step could still spend an authenticator code and be
//     re-issued with totpPending:false. Now: revoked → 401 + cookie cleared +
//     nothing spent; database unable to answer → 503, nothing spent.
// (2) "Wasn't me?" (disown-login) changed state on GET, so a mail link scanner
//     fetching the link signed the person out and locked them. Now GET only
//     renders a confirmation; the POST does the work, once.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a2-verify-disown-db-secret-0123456789abcdef01";
  return { fault: false };
});
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));
vi.mock("@/lib/prisma-tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prisma-tenant")>();
  return {
    ...real,
    withRlsBypass: (async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
      if (!h.fault) return real.withRlsBypass(fn as never, opts as never);
      h.fault = false;
      return real.withRlsBypass(async (tx) => {
        await (tx as unknown as { $queryRawUnsafe: (q: string) => Promise<unknown> }).$queryRawUnsafe("SELECT pg_terminate_backend(pg_backend_pid())");
        return fn(tx);
      }, opts as never);
    }) as typeof real.withRlsBypass,
  };
});

import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { signDisownToken } from "@/lib/login-event";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA2-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const ORIGIN = "http://localhost:3847";
const CLIENT = `198.51.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 200) + 20}`;
const SECRET = generateSecret();

describe.skipIf(!HAS_DB)("SF-37 on Postgres: verify routes check revocation; disown needs a confirmed POST", () => {
  const ids = { tenant: "", slug: "", coach: "", member: "", event: "" };

  async function pendingCookie(kind: "coach" | "member") {
    const token = await encode({
      salt: SESSION_COOKIE_NAME,
      secret: AUTH_SECRET_VALUE!,
      token: kind === "coach"
        ? { id: ids.coach, role: "coach", tenantId: ids.tenant, tenantSlug: ids.slug, sessionVersion: 0, memberId: null, totpPending: true, totpEnabled: true }
        : { id: ids.member, role: "member", tenantId: ids.tenant, tenantSlug: ids.slug, sessionVersion: 0, memberId: ids.member, totpPending: true, totpEnabled: true },
    });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }
  async function verify(kind: "coach" | "member", cookie: string, code: string) {
    const path = kind === "coach" ? "/api/auth/totp/verify" : "/api/member/totp/verify";
    const mod = kind === "coach" ? await import("@/app/api/auth/totp/verify/route") : await import("@/app/api/member/totp/verify/route");
    const req = new NextRequest(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", "x-vercel-forwarded-for": CLIENT },
      body: JSON.stringify({ code }),
    });
    return mod.POST(req);
  }
  const clearsCookie = (res: Response) =>
    res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
  const reissues = (res: Response) =>
    res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !/Max-Age=0/i.test(c));
  const coachStep = async () =>
    (await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.coach }, select: { totpLastUsedStep: true } }))).totpLastUsedStep;
  const memberState = async () =>
    withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: ids.member }, select: { sessionVersion: true, lockedUntil: true } }));
  const eventState = async () =>
    withRlsBypass((tx) => tx.loginEvent.findUniqueOrThrow({ where: { id: ids.event }, select: { disownedAt: true } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      ids.coach = (await tx.user.create({ data: { tenantId: t.id, email: E("coach"), name: "secA2 Coach", role: "coach", passwordHash: "synthetic-not-a-hash", totpEnabled: true, totpSecret: SECRET } })).id;
      ids.member = (await tx.member.create({ data: { tenantId: t.id, email: E("member"), name: "secA2 Member", passwordHash: "synthetic-not-a-hash", totpEnabled: true, totpSecret: SECRET } })).id;
      ids.event = (await tx.loginEvent.create({ data: { tenantId: t.id, memberId: ids.member, deviceHash: `${STAMP}-device`, ipApprox: "198.51.100.0", uaSummary: "Firefox 131 on Linux" } })).id;
    });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await new Promise((r) => setTimeout(r, 500));
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.loginEvent.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.member.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      users: await tx.user.count({ where: { tenantId: ids.tenant } }),
      members: await tx.member.count({ where: { tenantId: ids.tenant } }),
      events: await tx.loginEvent.count({ where: { tenantId: ids.tenant } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, members: 0, events: 0 });
  }, 120_000);

  it("database cannot answer the revocation question → 503, code not spent, cookie untouched", async () => {
    const before = await coachStep();
    h.fault = true; // one-shot: the next bypass read (the route's revocation lookup) fails
    const res = await verify("coach", await pendingCookie("coach"), generateSync({ secret: SECRET }));
    expect(res.status).toBe(503);
    expect(clearsCookie(res)).toBe(false);
    expect(await coachStep()).toBe(before);
  }, 60_000);

  it("positive control: a live pending session + a valid code → 200 and the token re-issued", async () => {
    const res = await verify("coach", await pendingCookie("coach"), generateSync({ secret: SECRET }));
    expect(res.status).toBe(200);
    expect(reissues(res)).toBe(true);
  }, 60_000);

  it("staff: revoked after the password step → 401, cookie cleared, code NOT spent", async () => {
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.coach }, data: { sessionVersion: { increment: 1 }, totpLastUsedStep: null } }));
    const before = await coachStep();
    const res = await verify("coach", await pendingCookie("coach"), generateSync({ secret: SECRET }));
    expect(res.status).toBe(401);
    expect(clearsCookie(res)).toBe(true);
    expect(reissues(res)).toBe(false);
    expect(await coachStep(), "the authenticator code was not spent").toBe(before);
  }, 60_000);

  it("member: positive control, then revoked → 401 and cleared", async () => {
    const ok = await verify("member", await pendingCookie("member"), generateSync({ secret: SECRET }));
    expect(ok.status).toBe(200);
    await withRlsBypass((tx) => tx.member.update({ where: { id: ids.member }, data: { sessionVersion: { increment: 1 } } }));
    const res = await verify("member", await pendingCookie("member"), generateSync({ secret: SECRET }));
    expect(res.status).toBe(401);
    expect(clearsCookie(res)).toBe(true);
    await withRlsBypass((tx) => tx.member.update({ where: { id: ids.member }, data: { sessionVersion: 0 } }));
  }, 60_000);

  it("disown: a GET (what a mail scanner does) changes nothing and shows a confirmation", async () => {
    const { GET } = await import("@/app/api/auth/disown-login/[token]/route");
    const before = await memberState();
    const token = signDisownToken(ids.event);
    const res = await GET(new Request(`${ORIGIN}/api/auth/disown-login/${token}`, { headers: { "x-vercel-forwarded-for": CLIENT } }), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(await res.text()).toContain('method="post"');
    expect(await memberState()).toEqual(before);
    expect((await eventState()).disownedAt).toBeNull();
  }, 60_000);

  it("disown: a cross-site POST is refused (403) before anything changes", async () => {
    const { POST } = await import("@/app/api/auth/disown-login/[token]/route");
    const before = await memberState();
    const token = signDisownToken(ids.event);
    const res = await POST(
      new Request(`${ORIGIN}/api/auth/disown-login/${token}`, { method: "POST", headers: { origin: "https://evil.example", "x-vercel-forwarded-for": CLIENT } }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(403);
    expect(await memberState()).toEqual(before);
    expect((await eventState()).disownedAt).toBeNull();
  }, 60_000);

  it("disown: the confirmed POST signs out everywhere, locks, marks the event — once, even if sent twice at once", async () => {
    const { POST } = await import("@/app/api/auth/disown-login/[token]/route");
    const before = await memberState();
    const token = signDisownToken(ids.event);
    const post = () =>
      POST(new Request(`${ORIGIN}/api/auth/disown-login/${token}`, { method: "POST", headers: { origin: ORIGIN, "x-vercel-forwarded-for": CLIENT } }), { params: Promise.resolve({ token }) });
    const [a, b] = await Promise.all([post(), post()]);
    for (const r of [a, b]) {
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toContain("/login?disowned=1");
    }
    const after = await memberState();
    expect(after.sessionVersion, "one disown, one version bump").toBe(before.sessionVersion + 1);
    expect(after.lockedUntil).not.toBeNull();
    expect((await eventState()).disownedAt).not.toBeNull();
    const audits = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.tenant, action: "auth.login.disowned" } }));
    expect(audits).toBe(1);
  }, 60_000);

  it("disown: a forged token — GET shows 'not valid' (400), POST changes nothing", async () => {
    const { GET, POST } = await import("@/app/api/auth/disown-login/[token]/route");
    const bad = "forged.token.value";
    const g = await GET(new Request(`${ORIGIN}/api/auth/disown-login/${bad}`), { params: Promise.resolve({ token: bad }) });
    expect(g.status).toBe(400);
    const p = await POST(new Request(`${ORIGIN}/api/auth/disown-login/${bad}`, { method: "POST", headers: { origin: ORIGIN, "x-vercel-forwarded-for": CLIENT } }), { params: Promise.resolve({ token: bad }) });
    expect(p.headers.get("location")).toContain("disowned=invalid");
  }, 60_000);
});
