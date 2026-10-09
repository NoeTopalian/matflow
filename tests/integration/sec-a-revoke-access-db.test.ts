// AH-R7 / SEC-013 — the operator incident control "sign out everywhere"
// (POST /api/admin/customers/[id]/revoke-access) against a REAL database.
// Security campaign lane A, 9 Oct 2026. Neon TEST branch only, through the
// guarded runners (owner role and matflow_app with RLS enforced).
//
// Real: the route, the operator MFA-session resolver (signed cookie + Operator
// row), the step-up grant (issued by issueStepUpGrant, verified by
// requireStepUp, spent inside the route's transaction), the session-revocation
// check, token retirement and the audit writer. Stubbed: rate limits and the
// cookie jar only. Mail: none is sent by this route.
//
// Pinned: scope user / member / club each end exactly the sessions in scope
// (checkSessionVersion → revoked) and retire exactly the sign-in tokens in
// scope (reset, login, first_time_signup — a waiver link is kept), never the
// other club's, never a password/TOTP/role; one outcome row per action with
// the operator and the grant's request id; replay of the same grant changes
// nothing and answers alreadyApplied; a grant for one scope or subject cannot
// be spent on another; no grant / no operator / an unknown subject is refused
// with nothing written; two concurrent submissions of one grant → one bump.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a-revoke-access-db-test-secret-0123456789abcdef";
  return { jar: new Map<string, string>() };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.11",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { CLUB_REVOKE_SUBJECT, STEP_UP_HEADER, issueStepUpGrant, stepUpTarget } from "@/lib/operator-step-up";
import { checkSessionVersion } from "@/lib/session-revocation";
import { POST as revokeRoute } from "@/app/api/admin/customers/[id]/revoke-access/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OP_ID = `${STAMP}-op`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const ORIGIN = "http://localhost:3847";
const REASON = "synthetic incident drill: suspected session theft (lane A)";

type Purpose = "reset" | "login" | "first_time_signup" | "waiver_open";

describe.skipIf(!HAS_DB)("operator revoke-all on Postgres (AH-R7 / SEC-013)", () => {
  const A = { tenant: "", owner: "", coach: "", pat: "", kid: "" };
  const B = { tenant: "", owner: "", pat: "" };
  const tokens: { id: string; tenantId: string; email: string; purpose: Purpose }[] = [];

  async function mint(tenantId: string, email: string, purpose: Purpose) {
    const raw = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 3600_000);
    const row = await withRlsBypass((tx) =>
      purpose === "reset"
        ? tx.passwordResetToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), expiresAt }, select: { id: true } })
        : tx.magicLinkToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), purpose, expiresAt }, select: { id: true } }),
    );
    tokens.push({ id: row.id, tenantId, email, purpose });
  }
  const usedState = async () =>
    withRlsBypass(async (tx) => {
      const out: Record<string, boolean> = {};
      for (const t of tokens) {
        const used =
          t.purpose === "reset"
            ? (await tx.passwordResetToken.findUniqueOrThrow({ where: { id: t.id } })).used
            : (await tx.magicLinkToken.findUniqueOrThrow({ where: { id: t.id } })).used;
        out[`${t.tenantId === A.tenant ? "A" : "B"}:${t.email.split("@")[0].split("-").pop()}:${t.purpose}`] = used;
      }
      return out;
    });
  const versions = async () =>
    withRlsBypass(async (tx) => {
      const us = await tx.user.findMany({ where: { tenantId: { in: [A.tenant, B.tenant] } }, select: { id: true, sessionVersion: true, passwordHash: true, role: true } });
      const ms = await tx.member.findMany({ where: { tenantId: { in: [A.tenant, B.tenant] } }, select: { id: true, sessionVersion: true, passwordHash: true } });
      return Object.fromEntries([...us, ...ms].map((r) => [r.id, r as { id: string; sessionVersion: number; passwordHash: string | null; role?: string }]));
    });
  const outcomeRows = () =>
    withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId: A.tenant, action: "admin.access.revoked" }, select: { operatorId: true, requestId: true, entityId: true, metadata: true } }),
    );

  const req = (tenantId: string, body: unknown, grant?: string) =>
    new Request(`${ORIGIN}/api/admin/customers/${tenantId}/revoke-access`, {
      method: "POST",
      headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...(grant ? { [STEP_UP_HEADER]: grant } : {}) },
      body: JSON.stringify(body),
    });
  async function call(tenantId: string, body: unknown, grant?: string) {
    const res = await revokeRoute(req(tenantId, body, grant), { params: Promise.resolve({ id: tenantId }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const grantFor = async (tenantId: string, subject: string, scope: string) =>
    (await issueStepUpGrant({ operatorId: OP_ID, action: "access.revoke_all", targetId: stepUpTarget(tenantId, subject, scope), change: {} })).grant;

  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `${STAMP}@operator.test`,
        name: "secA synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `${STAMP} A`, slug: `${STAMP}-a`.toLowerCase(), onboardingCompleted: true } });
      const b = await tx.tenant.create({ data: { name: `${STAMP} B`, slug: `${STAMP}-b`.toLowerCase(), onboardingCompleted: true } });
      A.tenant = a.id;
      B.tenant = b.id;
      A.owner = (await tx.user.create({ data: { tenantId: a.id, email: E("owner"), name: "secA Owner", role: "owner", passwordHash: "owner-hash-unchanged", totpEnabled: true, totpSecret: "synthetic" } })).id;
      A.coach = (await tx.user.create({ data: { tenantId: a.id, email: E("coach"), name: "secA Coach", role: "coach", passwordHash: "coach-hash-unchanged" } })).id;
      A.pat = (await tx.member.create({ data: { tenantId: a.id, email: E("pat"), name: "secA Pat", passwordHash: "pat-hash-unchanged" } })).id;
      A.kid = (await tx.member.create({ data: { tenantId: a.id, email: E("kid"), name: "secA Kid" } })).id;
      B.owner = (await tx.user.create({ data: { tenantId: b.id, email: E("bowner"), name: "secA B Owner", role: "owner", passwordHash: "b-hash" } })).id;
      // The SAME address as Pat, in another club: another person.
      B.pat = (await tx.member.create({ data: { tenantId: b.id, email: E("pat"), name: "secA Pat B", passwordHash: "patb-hash" } })).id;
    });
    for (const p of ["reset", "login", "first_time_signup", "waiver_open"] as const) {
      await mint(A.tenant, E("coach"), p);
      await mint(A.tenant, E("pat"), p);
      await mint(A.tenant, E("owner"), p);
      await mint(B.tenant, E("pat"), p);
    }
    h.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 0));
  }, 180_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 750)); // best-effort refusal rows land first
    for (const tenantId of [A.tenant, B.tenant].filter(Boolean)) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: [A.tenant, B.tenant] } } }),
      links: await tx.magicLinkToken.count({ where: { tenantId: { in: [A.tenant, B.tenant] } } }),
      codes: await tx.passwordResetToken.count({ where: { tenantId: { in: [A.tenant, B.tenant] } } }),
      opRows: await tx.auditLog.count({ where: { tenantId: null, entityId: OP_ID } }),
    }));
    expect(left).toEqual({ tenants: 0, links: 0, codes: 0, opRows: 0 });
    expect(await prisma.operator.count({ where: { id: OP_ID } })).toBe(0);
  }, 180_000);

  it("refusals change nothing: no operator session, no grant, unknown subject, wrong scope's grant", async () => {
    const before = { v: await versions(), t: await usedState() };

    const saved = h.jar.get(OP_SESSION_COOKIE)!;
    h.jar.delete(OP_SESSION_COOKIE);
    expect((await call(A.tenant, { scope: "user", subjectId: A.coach, reason: REASON })).status).toBe(403);
    h.jar.set(OP_SESSION_COOKIE, saved);

    const missing = await call(A.tenant, { scope: "user", subjectId: A.coach, reason: REASON });
    expect(missing.status).toBe(403);
    expect(missing.body.refusal).toBe("missing");

    expect((await call(A.tenant, { scope: "user", subjectId: B.owner, reason: REASON })).status, "a person of ANOTHER club is not found in this one").toBe(404);
    expect((await call(A.tenant, { scope: "user", subjectId: A.coach, reason: "short" })).status).toBe(400);
    expect((await call(A.tenant, { scope: "user", subjectId: A.coach, reason: REASON, role: "owner" })).status, "unknown keys are refused").toBe(400);

    // A grant bought for the coach cannot be spent on Pat, nor on the whole club.
    const coachGrant = await grantFor(A.tenant, A.coach, "user");
    const onPat = await call(A.tenant, { scope: "member", subjectId: A.pat, reason: REASON }, coachGrant);
    expect(onPat.body.refusal).toBe("wrong_target");
    const onClub = await call(A.tenant, { scope: "club", reason: REASON }, coachGrant);
    expect(onClub.body.refusal).toBe("wrong_target");
    // …nor in another club.
    const onB = await call(B.tenant, { scope: "user", subjectId: A.coach, reason: REASON }, coachGrant);
    expect(onB.status).toBe(404);

    expect({ v: await versions(), t: await usedState() }).toEqual(before);
    expect(await outcomeRows()).toHaveLength(0);
  }, 120_000);

  it("scope user: the coach's sessions end and the coach's sign-in tokens die; nobody else's", async () => {
    const before = await versions();
    const grant = await grantFor(A.tenant, A.coach, "user");
    const r = await call(A.tenant, { scope: "user", subjectId: A.coach, reason: REASON }, grant);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, scope: "user", sessionsRevoked: { users: 1, members: 0 }, tokensRetired: { resetCodes: 1, signInLinks: 2 } });

    expect(await checkSessionVersion({ userId: A.coach, tokenVersion: before[A.coach].sessionVersion })).toBe("revoked");
    expect(await checkSessionVersion({ userId: A.owner, tokenVersion: before[A.owner].sessionVersion }), "positive control").toBe("ok");
    const after = await versions();
    expect(after[A.coach].passwordHash, "evicts; never touches the password").toBe("coach-hash-unchanged");
    expect(after[A.coach].role).toBe("coach");

    const used = await usedState();
    expect([used["A:coach:reset"], used["A:coach:login"], used["A:coach:first_time_signup"]]).toEqual([true, true, true]);
    expect(used["A:coach:waiver_open"], "a waiver link is not a credential").toBe(false);
    expect(used["A:pat:login"]).toBe(false);
    expect(used["B:pat:login"]).toBe(false);

    const rows = await outcomeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorId: OP_ID, entityId: A.coach });
    expect(rows[0].requestId).toMatch(/^[a-f0-9]{64}$/);

    // Replay of the SAME grant: recorded result, nothing changes.
    const replay = await call(A.tenant, { scope: "user", subjectId: A.coach, reason: REASON }, grant);
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyApplied).toBe(true);
    expect((await versions())[A.coach].sessionVersion).toBe(after[A.coach].sessionVersion);
    expect(await outcomeRows()).toHaveLength(1);
  }, 120_000);

  it("scope member: Pat in club A is signed out; Pat's namesake in club B is not", async () => {
    const before = await versions();
    const r = await call(A.tenant, { scope: "member", subjectId: A.pat, reason: REASON }, await grantFor(A.tenant, A.pat, "member"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sessionsRevoked: { users: 0, members: 1 } });
    expect(await checkSessionVersion({ memberId: A.pat, tokenVersion: before[A.pat].sessionVersion })).toBe("revoked");
    expect(await checkSessionVersion({ memberId: B.pat, tokenVersion: before[B.pat].sessionVersion })).toBe("ok");
    const used = await usedState();
    expect(used["A:pat:login"]).toBe(true);
    expect(used["B:pat:login"], "the other club's identical address is another person").toBe(false);
  }, 120_000);

  it("two concurrent submissions of one grant: one bump, one outcome row", async () => {
    const before = await versions();
    const grant = await grantFor(A.tenant, A.kid, "member");
    const body = { scope: "member", subjectId: A.kid, reason: REASON };
    const [x, y] = await Promise.all([call(A.tenant, body, grant), call(A.tenant, body, grant)]);
    expect([x.status, y.status].every((s) => s === 200 || s === 403)).toBe(true);
    expect([x.body.alreadyApplied, y.body.alreadyApplied].filter(Boolean).length + [x, y].filter((r) => r.status === 403).length).toBe(1);
    expect((await versions())[A.kid].sessionVersion).toBe(before[A.kid].sessionVersion + 1);
    const rows = (await outcomeRows()).filter((r) => r.entityId === A.kid);
    expect(rows).toHaveLength(1);
  }, 120_000);

  it("scope club: every session and every sign-in token in club A ends; club B untouched", async () => {
    const before = await versions();
    const r = await call(A.tenant, { scope: "club", reason: REASON }, await grantFor(A.tenant, CLUB_REVOKE_SUBJECT, "club"));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: "club", sessionsRevoked: { users: 2, members: 2 } });
    for (const id of [A.owner, A.coach]) {
      expect(await checkSessionVersion({ userId: id, tokenVersion: before[id].sessionVersion })).toBe("revoked");
    }
    for (const id of [A.pat, A.kid]) {
      expect(await checkSessionVersion({ memberId: id, tokenVersion: before[id].sessionVersion })).toBe("revoked");
    }
    expect(await checkSessionVersion({ userId: B.owner, tokenVersion: before[B.owner].sessionVersion })).toBe("ok");
    const used = await usedState();
    for (const [k, v] of Object.entries(used)) {
      if (k.startsWith("A:") && !k.endsWith("waiver_open")) expect(v, k).toBe(true);
      if (k.startsWith("B:")) expect(v, k).toBe(false);
    }
    const after = await versions();
    expect(after[A.owner].passwordHash).toBe("owner-hash-unchanged");
  }, 120_000);
});
