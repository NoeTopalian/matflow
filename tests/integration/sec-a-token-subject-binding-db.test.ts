// AH-D2 / SEC-003 / SEC-004 against a REAL database (security campaign lane
// A, 9 Oct 2026). Neon TEST branch only, through the guarded runners (owner
// role and matflow_app with RLS enforced). Mail is never sent: lib/email is
// replaced by a recorder (no transport is constructed at all) and the
// recorder only hands the test the link or code the route would have mailed.
//
// The question: can a sign-in credential minted for one person authenticate a
// DIFFERENT person after the address changes hands? Address MOVES retire
// tokens (tests/integration/token-scoping-db.test.ts); this file covers the
// writers that delete a holder and create a new one at the same address —
// staff removal (the real DELETE route), member deletion (the real
// lib/member-delete.ts cascade) — which retire nothing. At 2a6487e each case
// below signs in, or sets the password of, the NEW person (red run recorded in
// docs/security/evidence/A/). Each has a positive control: the new person's
// OWN credential works.
//
// Also: two concurrent redemptions of one invitation on two pooled
// connections (exactly one wins), code replay, expiry, and a tampered tag.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a-token-binding-db-test-secret-0123456789abcdef";
  // The routes only reach the (replaced) sender when a provider key exists.
  process.env.RESEND_API_KEY = "re_synthetic_lane_a_not_a_key";
  return {
    mail: [] as { templateId: string; to: string; vars: Record<string, string> }[],
    session: null as null | Record<string, unknown>,
  };
});

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (args: { templateId: string; to: string; vars: Record<string, string> }) => {
    h.mail.push({ templateId: args.templateId, to: args.to, vars: args.vars });
    return { ok: true, logId: "recorded-not-sent" };
  }),
}));
vi.mock("@/lib/email-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-delivery")>()),
  isEmailDeliveryOn: () => true,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.10",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

import { NextRequest } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { mintSubjectBoundToken } from "@/lib/auth-token-binding";
import { deleteMemberCascade } from "@/lib/member-delete";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";
import { POST as requestLink } from "@/app/api/magic-link/request/route";
import { GET as verifyLink } from "@/app/api/magic-link/verify/route";
import { POST as forgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";
import { POST as acceptInvite } from "@/app/api/members/accept-invite/route";
import { DELETE as staffDelete } from "@/app/api/staff/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const ORIGIN = "http://localhost:3847";
/** Synthetic passwords that satisfy both policies; credentials of nothing real. */
const PW_NEW = `Synthetic-${STAMP}-Bb2`;
const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_DB)("sign-in credentials are bound to the person they were minted for (AH-D2)", () => {
  const ids = { tenant: "", slug: "", owner: "" };

  const lastMail = (templateId: string, to: string) => {
    const m = [...h.mail].reverse().find((x) => x.templateId === templateId && x.to === to);
    if (!m) throw new Error(`no ${templateId} recorded for the address`);
    return m.vars;
  };
  const linkToken = (link: string) => new URL(link).searchParams.get("token")!;
  const verify = async (token: string) => {
    const res = await verifyLink(new NextRequest(`${ORIGIN}/api/magic-link/verify?token=${encodeURIComponent(token)}`));
    return { status: res.status, location: res.headers.get("location") ?? "", cookie: res.cookies.get(SESSION_COOKIE_NAME)?.value ?? null };
  };
  const user = (id: string) => withRlsBypass((tx) => tx.user.findUnique({ where: { id }, select: { passwordHash: true, sessionVersion: true } }));
  const member = (id: string) =>
    withRlsBypass((tx) => tx.member.findUnique({ where: { id }, select: { passwordHash: true, sessionVersion: true } }));
  const mkMember = (email: string, name: string, passwordHash: string | null) =>
    withRlsBypass(async (tx) => (await tx.member.create({ data: { tenantId: ids.tenant, email, name, passwordHash } })).id);
  const delMember = (id: string) =>
    withRlsBypass((tx) => deleteMemberCascade(tx, { id, tenantId: ids.tenant }), { timeout: 60_000 });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
      ids.owner = (await tx.user.create({ data: { tenantId: t.id, email: E("owner"), name: "secA Owner", role: "owner", passwordHash: "synthetic-not-a-hash" } })).id;
    });
    h.session = { user: { id: ids.owner, tenantId: ids.tenant, role: "owner" } };
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await new Promise((r) => setTimeout(r, 750)); // best-effort audit rows land first
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.magicLinkToken.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.passwordResetToken.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.loginEvent.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.member.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.passwordHistory.deleteMany({ where: { user: { tenantId: ids.tenant } } });
      await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      users: await tx.user.count({ where: { tenantId: ids.tenant } }),
      members: await tx.member.count({ where: { tenantId: ids.tenant } }),
      links: await tx.magicLinkToken.count({ where: { tenantId: ids.tenant } }),
      codes: await tx.passwordResetToken.count({ where: { tenantId: ids.tenant } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, members: 0, links: 0, codes: 0 });
  }, 120_000);

  it("SEC-004 login link: a coach is removed and a different person gets the address — the old link signs nobody in", async () => {
    const X = E("coach-x");
    const c1 = await withRlsBypass(async (tx) => (await tx.user.create({ data: { tenantId: ids.tenant, email: X, name: "secA Coach One", role: "coach", passwordHash: "synthetic-not-a-hash" } })).id);
    expect((await requestLink(post("/api/magic-link/request", { email: X, tenantSlug: ids.slug }))).status).toBe(200);
    const oldToken = linkToken(lastMail("magic_link", X).link);
    expect(oldToken, "the link carries a subject tag").toMatch(/^[a-f0-9]{64}\.[a-f0-9]{32}$/);

    // The real staff-removal route (retires nothing), then a new person at X.
    const del = await staffDelete(new Request(`${ORIGIN}/api/staff/${c1}`, { method: "DELETE", headers: { origin: ORIGIN, host: "localhost:3847" } }), { params: Promise.resolve({ id: c1 }) });
    expect(del.status).toBe(200);
    const c2 = await withRlsBypass(async (tx) => (await tx.user.create({ data: { tenantId: ids.tenant, email: X, name: "secA Coach Two", role: "coach", passwordHash: "synthetic-not-a-hash" } })).id);

    const stolen = await verify(oldToken);
    expect(stolen.location).toContain("/login?error=invalid_link");
    expect(stolen.cookie, "no session minted for the new holder").toBeNull();
    // The refusal row is best-effort (written after the response): poll briefly.
    let refusal = 0;
    for (let i = 0; i < 20 && refusal === 0; i++) {
      refusal = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.tenant, action: "auth.magic_link.refused_subject", entityId: c2 } }));
      if (refusal === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(refusal).toBe(1);

    // Positive control: the new holder's OWN link signs them in.
    await requestLink(post("/api/magic-link/request", { email: X, tenantSlug: ids.slug }));
    const own = await verify(linkToken(lastMail("magic_link", X).link));
    expect(own.location).toContain("/dashboard");
    expect(own.cookie).toBeTruthy();
  }, 120_000);

  it("SEC-003 reset code: a member is deleted and a different person gets the address — the old code resets nobody", async () => {
    const Y = E("member-y");
    const m1 = await mkMember(Y, "secA Member One", "synthetic-not-a-hash");
    await forgotPassword(post("/api/auth/forgot-password", { email: Y, tenantSlug: ids.slug }));
    const oldCode = lastMail("password_reset", Y).code;
    expect(oldCode).toMatch(/^\d{6}$/);

    expect((await delMember(m1)).kind).toBe("ok"); // the real cascade: retires nothing
    const m2 = await mkMember(Y, "secA Member Two", "m2-hash-unchanged");

    const res = await resetPassword(post("/api/auth/reset-password", { token: oldCode, email: Y, tenantSlug: ids.slug, password: PW_NEW }));
    expect(res.status).toBe(400);
    expect(await member(m2)).toEqual({ passwordHash: "m2-hash-unchanged", sessionVersion: 0 });

    // Positive control: the new holder's OWN code works once, and only once.
    await forgotPassword(post("/api/auth/forgot-password", { email: Y, tenantSlug: ids.slug }));
    const ownCode = lastMail("password_reset", Y).code;
    const ok = await resetPassword(post("/api/auth/reset-password", { token: ownCode, email: Y, tenantSlug: ids.slug, password: PW_NEW }));
    expect(ok.status).toBe(200);
    const after = await member(m2);
    expect(after?.passwordHash).not.toBe("m2-hash-unchanged");
    expect(after?.sessionVersion).toBe(1);
    const replay = await resetPassword(post("/api/auth/reset-password", { token: ownCode, email: Y, tenantSlug: ids.slug, password: `${PW_NEW}x` }));
    expect(replay.status, "a spent code is not reusable").toBe(400);
  }, 120_000);

  it("SEC-003 an expired bound code is refused", async () => {
    const Q = E("member-q");
    const m = await mkMember(Q, "secA Member Q", "q-hash-unchanged");
    await forgotPassword(post("/api/auth/forgot-password", { email: Q, tenantSlug: ids.slug }));
    const code = lastMail("password_reset", Q).code;
    await withRlsBypass((tx) => tx.passwordResetToken.updateMany({ where: { tenantId: ids.tenant, email: Q }, data: { expiresAt: new Date(Date.now() - 1000) } }));
    const res = await resetPassword(post("/api/auth/reset-password", { token: code, email: Q, tenantSlug: ids.slug, password: PW_NEW }));
    expect(res.status).toBe(400);
    expect((await member(m))?.passwordHash).toBe("q-hash-unchanged");
  }, 60_000);

  it("SEC-004 bound invitation: a member is deleted and a different person gets the address — the old invitation sets nobody's password", async () => {
    const Z = E("member-z");
    const m3 = await mkMember(Z, "secA Member Three", null);
    // As an invitation issuer calling mintSubjectBoundToken would mint it.
    const raw = mintSubjectBoundToken({ purpose: "first_time_signup", tenantId: ids.tenant, subject: { kind: "member", id: m3 } });
    const row = await withRlsBypass((tx) =>
      tx.magicLinkToken.create({ data: { tenantId: ids.tenant, email: Z, tokenHash: hashToken(raw), purpose: "first_time_signup", expiresAt: new Date(Date.now() + 7 * 86400_000) }, select: { id: true } }),
    );
    expect((await delMember(m3)).kind).toBe("ok");
    const m4 = await mkMember(Z, "secA Member Four", null);

    const res = await acceptInvite(post("/api/members/accept-invite", { token: raw, password: PW_NEW }));
    expect(res.status).toBe(410);
    expect((await member(m4))?.passwordHash, "no password set on the new person").toBeNull();
    const left = await withRlsBypass((tx) => tx.magicLinkToken.findUniqueOrThrow({ where: { id: row.id }, select: { used: true } }));
    expect(left.used, "refused before the claim: nothing consumed").toBe(false);

    // Positive control: an invitation bound to the new person works.
    const own = mintSubjectBoundToken({ purpose: "first_time_signup", tenantId: ids.tenant, subject: { kind: "member", id: m4 } });
    await withRlsBypass((tx) => tx.magicLinkToken.create({ data: { tenantId: ids.tenant, email: Z, tokenHash: hashToken(own), purpose: "first_time_signup", expiresAt: new Date(Date.now() + 7 * 86400_000) } }));
    const ok = await acceptInvite(post("/api/members/accept-invite", { token: own, password: PW_NEW }));
    expect(ok.status).toBe(200);
    expect((await member(m4))?.passwordHash).toBeTruthy();
  }, 120_000);

  it("SEC-003 two concurrent redemptions of one invitation (two pooled connections): exactly one wins", async () => {
    const W = E("member-w");
    const m = await mkMember(W, "secA Member W", null);
    const raw = mintSubjectBoundToken({ purpose: "first_time_signup", tenantId: ids.tenant, subject: { kind: "member", id: m } });
    await withRlsBypass((tx) => tx.magicLinkToken.create({ data: { tenantId: ids.tenant, email: W, tokenHash: hashToken(raw), purpose: "first_time_signup", expiresAt: new Date(Date.now() + 86400_000) } }));
    const [a, b] = await Promise.all([
      acceptInvite(post("/api/members/accept-invite", { token: raw, password: PW_NEW })),
      acceptInvite(post("/api/members/accept-invite", { token: raw, password: `${PW_NEW}z` })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 410]);
    expect((await member(m))?.sessionVersion, "the claim and the write happened once").toBe(1);
  }, 60_000);

  it("a tampered tag finds no token at all", async () => {
    const T = E("coach-t");
    await withRlsBypass((tx) => tx.user.create({ data: { tenantId: ids.tenant, email: T, name: "secA Coach T", role: "coach", passwordHash: "synthetic-not-a-hash" } }));
    await requestLink(post("/api/magic-link/request", { email: T, tenantSlug: ids.slug }));
    const good = linkToken(lastMail("magic_link", T).link);
    const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const res = await verify(flipped);
    expect(res.location).toContain("/login?error=invalid_link");
    expect(res.cookie).toBeNull();
    // …and the genuine one still works (it was not consumed by the forgery).
    expect((await verify(good)).location).toContain("/dashboard");
  }, 60_000);

  it("RNG sanity for the fixtures (not a security claim)", () => {
    expect(randomBytes(4).length).toBe(4);
    expect(typeof user).toBe("function");
  });
});
