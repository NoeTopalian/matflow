// Security lane B (9 Oct 2026) — AH-C2 version-at-check semantics (SEC-028
// TOCTOU / stale version writes). TEST branch only, synthetic data, both DB
// roles. Drives the real hub routes and the real grant issuer.
//
// What is bound to what, measured on the database:
//   member contact route — the version the operator SAW (returned by the
//     address check) travels in the body and is compared at preflight and again
//     inside the transaction; the grant separately binds the state at issue.
//     A record that changed between the check and the code → 409 stale,
//     nothing written, the grant still unspent; re-check → same grant succeeds.
//   owner login route — no page-load version exists: the grant binds the owner's
//     state when the code is entered (AH-C2, OPEN Low). A change of the owner's
//     address AFTER the code was entered is refused (409 stale) and nothing is
//     written; a change BEFORE the code was entered is not detected (cell 4
//     characterises it so a fix shows up as a deliberate test change).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-b-version-at-check-db-test-secret-0123456789abcdef";
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
  getClientIp: () => "203.0.113.43",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { issueOperatorSession } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant } from "@/lib/operator-step-up";
import { POST as checkRoute } from "@/app/api/admin/customers/[id]/login-email/check/route";
import { POST as contactRoute } from "@/app/api/admin/customers/[id]/members/[memberId]/contact-email/route";
import { POST as ownerRoute } from "@/app/api/admin/customers/[id]/login-email/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();
const OP_ID = `${STAMP}-op`;
const E = (who: string) => `${SLUG}-${who}@example.test`;
const ORIGIN = "http://localhost:3847";
const REASON = "lane B synthetic version-binding ticket, verified by call-back";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nonceOf = (grant: string) => (JSON.parse(Buffer.from(grant.split(".")[0], "base64url").toString("utf8")) as { n: string }).n;
const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

describe.skipIf(!HAS_DB)(`AH-C2 version binding on the database (${ROLE} role)`, () => {
  const ids = { a: "", owner: "", mem: "" };
  const nonceHash = async () => (await prisma.operator.findUnique({ where: { id: OP_ID }, select: { stepUpNonceHash: true } }))?.stepUpNonceHash ?? null;
  const member = () => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: ids.mem }, select: { email: true, passwordHash: true, sessionVersion: true } }));
  const owner = () => withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.owner }, select: { email: true, sessionVersion: true, loginEmailProvisionalSince: true } }));
  const check = async (email: string) => read(await checkRoute(req(`/api/admin/customers/${ids.a}/login-email/check`, { email }), { params: Promise.resolve({ id: ids.a }) }));
  const contact = async (body: unknown, grant: string) =>
    read(await contactRoute(req(`/api/admin/customers/${ids.a}/members/${ids.mem}/contact-email`, body, { [STEP_UP_HEADER]: grant }), { params: Promise.resolve({ id: ids.a, memberId: ids.mem }) }));
  const ownerChange = async (newEmail: string, grant: string) =>
    read(await ownerRoute(req(`/api/admin/customers/${ids.a}/login-email`, { action: "change", reason: REASON, newEmail }, { [STEP_UP_HEADER]: grant }), { params: Promise.resolve({ id: ids.a }) }));

  beforeAll(async () => {
    await prisma.operator.create({
      data: { id: OP_ID, email: `${SLUG}@operator.test`, name: "Lane B synthetic operator", passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a", totpEnabled: true, totpSecret: "SYNTHETICSECRETNOTUSED" },
    });
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `${STAMP} Club`, slug: `${SLUG}-a`, onboardingCompleted: true } });
      ids.a = a.id;
      ids.owner = (await tx.user.create({ data: { tenantId: a.id, email: E("owner-x"), name: "Synthetic Owner", role: "owner", passwordHash: "owner-hash", totpEnabled: true, totpSecret: "synthetic" } })).id;
      ids.mem = (await tx.member.create({ data: { tenantId: a.id, name: "Morgan Imported", email: E("target"), externalRef: `teamup:${E("target")}|morgan imported` } })).id;
    });
    h.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 0));
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 750));
    if (ids.a) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId: ids.a } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId: ids.a } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId: ids.a } });
        await tx.member.deleteMany({ where: { tenantId: ids.a } });
        await tx.user.deleteMany({ where: { tenantId: ids.a } });
        await tx.tenant.delete({ where: { id: ids.a } });
      }, { timeout: 60_000 });
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    const left = await withRlsBypass(async (tx) => ({ tenants: await tx.tenant.count({ where: { slug: { startsWith: SLUG } } }), operators: await tx.operator.count({ where: { id: OP_ID } }) }));
    expect(left).toEqual({ tenants: 0, operators: 0 });
  }, 120_000);

  it("1. member: the record changes AFTER the check but BEFORE the code (member activates a password) → 409 stale with a FRESH grant; nothing written; grant unspent", async () => {
    const seen = String(((await check(E("target"))).body.holder as { version: string }).version);
    await withRlsBypass((tx) => tx.member.update({ where: { id: ids.mem }, data: { passwordHash: "member-set-a-password" } }));
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "member.contact_email", targetId: `${ids.a}/${ids.mem}/change`, change: { newEmail: E("own") } });
    const before = await member();
    const r = await contact({ newEmail: E("own"), reason: REASON, version: seen }, grant);
    expect(r.status).toBe(409);
    expect(r.body.result).toBe("stale");
    expect(await member()).toEqual(before);
    expect(await nonceHash()).toBe(sha256(nonceOf(grant)));
    // Positive control: re-check (the operator now SEES the password) → the same grant succeeds.
    const fresh = String(((await check(E("target"))).body.holder as { version: string }).version);
    expect(fresh).not.toBe(seen);
    const ok = await contact({ newEmail: E("own"), reason: REASON, version: fresh }, grant);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await member()).toMatchObject({ email: E("own"), sessionVersion: before.sessionVersion + 1 });
  });

  it("2. member: the record changes AFTER the code (grant and check both older) → 409 stale; nothing written", async () => {
    const seen = String(((await check(E("own"))).body.holder as { version: string }).version);
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "member.contact_email", targetId: `${ids.a}/${ids.mem}/change`, change: { newEmail: E("own-2") } });
    await withRlsBypass((tx) => tx.member.update({ where: { id: ids.mem }, data: { sessionVersion: { increment: 1 } } })); // e.g. signed out everywhere
    const before = await member();
    const r = await contact({ newEmail: E("own-2"), reason: REASON, version: seen }, grant);
    expect(r.status).toBe(409);
    expect(await member()).toEqual(before);
  });

  it("3. owner: the owner changes their own address AFTER the code was entered → 409 stale; nothing written", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.login_email", targetId: `${ids.a}/${ids.owner}/change`, change: { newEmail: E("owner-z") } });
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.owner }, data: { email: E("owner-y"), sessionVersion: { increment: 1 } } }));
    const before = await owner();
    const r = await ownerChange(E("owner-z"), grant);
    expect(r.status).toBe(409);
    expect(r.body.refusal).toBe("stale");
    expect(await owner()).toEqual(before);
  });

  it("4. owner (AH-C2 characterisation, OPEN Low): a change made BEFORE the code was entered is bound into the grant and is overwritten", async () => {
    // The operator's page showed owner-y (cell 3 left it there). The owner now
    // sets owner-w themselves; the operator, still looking at owner-y, enters
    // the code for owner-z. No page-load version exists to compare.
    await withRlsBypass((tx) => tx.user.update({ where: { id: ids.owner }, data: { email: E("owner-w"), sessionVersion: { increment: 1 } } }));
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.login_email", targetId: `${ids.a}/${ids.owner}/change`, change: { newEmail: E("owner-z") } });
    const before = await owner();
    const r = await ownerChange(E("owner-z"), grant);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await owner();
    expect(after.email).toBe(E("owner-z")); // owner-w, never shown to the operator, is replaced
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(after.loginEmailProvisionalSince).not.toBeNull();
  });
});
