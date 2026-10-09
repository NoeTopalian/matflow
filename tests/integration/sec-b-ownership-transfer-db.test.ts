// Security lane B (9 Oct 2026) — ownership transfer on the database (AH-R7
// transfer part, SEC-032; also SEC-017 object-level, SEC-013 stale roles).
// TEST branch only, synthetic data, both DB roles (owner runner and
// matflow_app with RLS).
//
// Drives the REAL routes:
//   POST /api/staff/[id]/transfer-ownership             (the owner, password re-entered)
//   POST /api/admin/customers/[id]/transfer-ownership   (operator, step-up)
// and the REAL per-request revocation check (lib/session-revocation.ts
// checkSessionVersion, which auth.ts's jwt callback calls on every Node pass).
//
// Cells: old sessions of BOTH people are revoked; a stale owner JWT cannot
// transfer again (the route re-reads the role in the database); a fresh session
// for the old owner carries manager and is refused an owner-only route while the
// new owner passes it (positive control); a target in another club is 404 and
// that club is byte-identical; operator replay is answered from the record; and
// the races — two concurrent owner transfers, and an owner transfer racing an
// operator transfer, each on its own connection — leave EXACTLY ONE owner.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import bcrypt from "bcryptjs";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-b-ownership-transfer-db-test-secret-0123456789abcdef";
  return { jar: new Map<string, string>(), session: null as null | Record<string, unknown> };
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
  getClientIp: () => "203.0.113.32",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { issueOperatorSession } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, stepUpTarget } from "@/lib/operator-step-up";
import { checkSessionVersion } from "@/lib/session-revocation";
import { POST as selfTransfer } from "@/app/api/staff/[id]/transfer-ownership/route";
import { POST as opTransfer } from "@/app/api/admin/customers/[id]/transfer-ownership/route";
import { POST as staffCreate } from "@/app/api/staff/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();
const OP_ID = `${STAMP}-op`;
const E = (who: string) => `${SLUG}-${who}@example.test`;
const ORIGIN = "http://localhost:3847";
const PW = `Synthetic-${SLUG}-Aa1`;
const REASON = "lane B synthetic ownership transfer ticket";

const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function read(res: Response) {
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe.skipIf(!HAS_DB)(`ownership transfer on the database (${ROLE} role)`, () => {
  const ids = { a: "", aName: "", b: "", owner: "", mgr: "", c1: "", c2: "", bOwner: "", bCoach: "" };
  let hash = "";
  const users = (tenantId: string) =>
    withRlsBypass((tx) => tx.user.findMany({ where: { tenantId }, select: { id: true, role: true, sessionVersion: true, email: true, passwordHash: true }, orderBy: { id: "asc" } }));
  const owners = async (tenantId: string) => (await users(tenantId)).filter((u) => u.role === "owner").map((u) => u.id);
  const sessionFor = (u: { id: string; role: string; sessionVersion: number }, tenantId = ids.a) =>
    ({ user: { id: u.id, tenantId, role: u.role, totpEnabled: true, sessionVersion: u.sessionVersion, mustChangePassword: false } });
  const row = async (id: string) => (await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id }, select: { id: true, role: true, sessionVersion: true } })));
  /** Back to: owner = `ids.owner`, everyone else in club A a coach/manager as created. */
  const resetRoles = () =>
    withRlsBypass(async (tx) => {
      await tx.user.update({ where: { id: ids.owner }, data: { role: "owner" } });
      await tx.user.update({ where: { id: ids.mgr }, data: { role: "manager" } });
      await tx.user.updateMany({ where: { id: { in: [ids.c1, ids.c2] } }, data: { role: "coach" } });
    });
  const self = async (asId: string, targetId: string, password = PW) => {
    const me = await row(asId);
    h.session = sessionFor({ ...me, role: "owner" }); // the JWT as minted while they owned the club
    const r = await read(await selfTransfer(req(`/api/staff/${targetId}/transfer-ownership`, { password }), { params: Promise.resolve({ id: targetId }) }));
    return r;
  };
  const operator = async (targetId: string) => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "tenant.transfer_ownership", targetId: stepUpTarget(ids.a, targetId), change: {} });
    return { grant, run: async () =>
      read(
        await opTransfer(req(`/api/admin/customers/${ids.a}/transfer-ownership`, { targetUserId: targetId, reason: REASON, confirmName: ids.aName }, { [STEP_UP_HEADER]: grant }), {
          params: Promise.resolve({ id: ids.a }),
        }),
      ) };
  };

  beforeAll(async () => {
    hash = bcrypt.hashSync(PW, 4);
    await prisma.operator.create({
      data: { id: OP_ID, email: `${SLUG}@operator.test`, name: "Lane B synthetic operator", passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a", totpEnabled: true, totpSecret: "SYNTHETICSECRETNOTUSED" },
    });
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `${STAMP} Club A`, slug: `${SLUG}-a`, onboardingCompleted: true } });
      const b = await tx.tenant.create({ data: { name: `${STAMP} Club B`, slug: `${SLUG}-b`, onboardingCompleted: true } });
      ids.a = a.id; ids.aName = a.name; ids.b = b.id;
      const mk = (tenantId: string, who: string, role: string) =>
        tx.user.create({ data: { tenantId, email: E(who), name: `Synthetic ${who}`, role, passwordHash: hash, totpEnabled: true, totpSecret: "synthetic" }, select: { id: true } }).then((u) => u.id);
      ids.owner = await mk(a.id, "owner", "owner");
      ids.mgr = await mk(a.id, "mgr", "manager");
      ids.c1 = await mk(a.id, "c1", "coach");
      ids.c2 = await mk(a.id, "c2", "coach");
      ids.bOwner = await mk(b.id, "b-owner", "owner");
      ids.bCoach = await mk(b.id, "b-coach", "coach");
    });
    h.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 0));
  }, 120_000);

  afterAll(async () => {
    h.session = null;
    await new Promise((r) => setTimeout(r, 750));
    for (const tenantId of [ids.a, ids.b].filter(Boolean)) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.passwordHistory.deleteMany({ where: { user: { tenantId } } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { slug: { startsWith: SLUG } } }),
      users: await tx.user.count({ where: { email: { startsWith: SLUG } } }),
      operators: await tx.operator.count({ where: { id: OP_ID } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, operators: 0 });
  }, 120_000);

  it("1. owner → manager transfer: roles swap, BOTH people's old sessions are revoked on the database; a bystander's stays valid", async () => {
    const before = { o: await row(ids.owner), m: await row(ids.mgr), c: await row(ids.c1) };
    const r = await self(ids.owner, ids.mgr);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await row(ids.owner)).toMatchObject({ role: "manager", sessionVersion: before.o.sessionVersion + 1 });
    expect(await row(ids.mgr)).toMatchObject({ role: "owner", sessionVersion: before.m.sessionVersion + 1 });
    expect(await checkSessionVersion({ userId: ids.owner, memberId: null, tokenVersion: before.o.sessionVersion })).toBe("revoked");
    expect(await checkSessionVersion({ userId: ids.mgr, memberId: null, tokenVersion: before.m.sessionVersion })).toBe("revoked");
    // Positive controls: the new tokens, and an uninvolved coach's token.
    expect(await checkSessionVersion({ userId: ids.owner, memberId: null, tokenVersion: before.o.sessionVersion + 1 })).toBe("ok");
    expect(await checkSessionVersion({ userId: ids.c1, memberId: null, tokenVersion: before.c.sessionVersion })).toBe("ok");
    const audit = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: ids.a, action: "staff.ownership_transferred" }, select: { metadata: true } }));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ previousOwnerId: ids.owner, newOwnerId: ids.mgr });
  });

  it("2. a STALE owner JWT cannot transfer again (role re-read in the database) — nothing changes", async () => {
    const before = await users(ids.a);
    const r = await self(ids.owner, ids.c1);
    expect(r.status).toBe(403);
    expect(await users(ids.a)).toEqual(before);
  });

  it("3. tenant privileges follow the database: the old owner's fresh session (manager) is refused an owner-only route; the new owner passes it", async () => {
    h.session = sessionFor(await row(ids.owner));
    const refused = await read(await staffCreate(req("/api/staff", { name: "Should Not Exist", email: E("nope"), role: "coach", password: PW })));
    expect(refused.status).toBe(403);
    expect(await withRlsBypass((tx) => tx.user.count({ where: { email: E("nope") } }))).toBe(0);
    h.session = sessionFor(await row(ids.mgr));
    const ok = await read(await staffCreate(req("/api/staff", { name: "Positive Control", email: E("ok"), role: "coach", password: PW })));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await withRlsBypass((tx) => tx.user.deleteMany({ where: { tenantId: ids.a, email: E("ok") } }));
    h.session = null;
  });

  it("4. object-level: club A's owner naming club B's coach is 404 and club B is byte-identical", async () => {
    const bBefore = await users(ids.b);
    const r = await self(ids.mgr, ids.bCoach); // mgr owns club A now
    expect(r.status).toBe(404);
    expect(await users(ids.b)).toEqual(bBefore);
    expect(await owners(ids.a)).toEqual([ids.mgr]);
  });

  it("5. operator transfer: one owner after; replay of the same grant answered from the record", async () => {
    await resetRoles();
    const op = await operator(ids.c1);
    const r = await op.run();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await owners(ids.a)).toEqual([ids.c1]);
    expect((await row(ids.owner)).role).toBe("manager");
    const again = await op.run();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyApplied: true });
    expect(await owners(ids.a)).toEqual([ids.c1]);
  });

  it("6. race: two concurrent owner transfers (to different people, two connections) leave EXACTLY ONE owner", async () => {
    const seen: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await resetRoles();
      const me = await row(ids.owner);
      h.session = sessionFor({ ...me, role: "owner" });
      const results = await Promise.all(
        [ids.c1, ids.c2].map(async (t) => read(await selfTransfer(req(`/api/staff/${t}/transfer-ownership`, { password: PW }), { params: Promise.resolve({ id: t }) }))),
      );
      const o = await owners(ids.a);
      seen.push(o);
      expect(results.filter((x) => x.status === 200).length, JSON.stringify(results)).toBeGreaterThanOrEqual(1);
      expect(o, `iteration ${i}: ${JSON.stringify(results.map((x) => x.status))}`).toHaveLength(1);
    }
    h.session = null;
  }, 300_000);

  it("7. race: an owner transfer racing an operator transfer leave EXACTLY ONE owner", async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      const [selfDelay, opDelay] = [[0, 0], [0, 60], [60, 0]][i % 3];
      await resetRoles();
      const me = await row(ids.owner);
      const op = await operator(ids.c2);
      h.session = sessionFor({ ...me, role: "owner" });
      const results = await Promise.all([
        (async () => { await wait(selfDelay); return read(await selfTransfer(req(`/api/staff/${ids.c1}/transfer-ownership`, { password: PW }), { params: Promise.resolve({ id: ids.c1 }) })); })(),
        (async () => { await wait(opDelay); return op.run(); })(),
      ]);
      const o = await owners(ids.a);
      expect(results.filter((x) => x.status === 200).length, JSON.stringify(results)).toBeGreaterThanOrEqual(1);
      expect(o, `iteration ${i}: ${JSON.stringify(results.map((x) => x.status))}`).toHaveLength(1);
    }
    h.session = null;
  }, 300_000);
/**
   * Deterministic interleaving: a third connection holds the current owner's
   * row lock, both requests read "you are the owner" and queue on their
   * UPDATE, then the lock is released. Pre-fix code: both commit (two owners).
   */
  async function withOwnerRowHeld<T>(run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ids.owner} FOR UPDATE`;
      locked();
      await released;
    }, { timeout: 60_000, maxWait: 10_000 });
    await isLocked;
    const p = run();
    await new Promise((r) => setTimeout(r, 4000));
    release();
    await holder;
    return p;
  }

  it("8a. forced interleaving (row lock held by a third connection): owner × owner leave EXACTLY ONE owner; the loser is 409", async () => {
    // owner × owner
    await resetRoles();
    h.session = sessionFor({ ...(await row(ids.owner)), role: "owner" });
    const a = await withOwnerRowHeld(() =>
      Promise.all([ids.c1, ids.c2].map(async (t) => read(await selfTransfer(req(`/api/staff/${t}/transfer-ownership`, { password: PW }), { params: Promise.resolve({ id: t }) })))),
    );
    expect(await owners(ids.a), JSON.stringify(a.map((x) => x.status))).toHaveLength(1);
    expect(a.map((x) => x.status).sort()).toEqual([200, 409]);
    h.session = null;
  }, 300_000);

  it("8b. forced interleaving: owner × OPERATOR leave EXACTLY ONE owner; the loser is 409 and wrote no audit row", async () => {
    await resetRoles();
    const op = await operator(ids.c2);
    h.session = sessionFor({ ...(await row(ids.owner)), role: "owner" });
    const auditBefore = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.a, action: { in: ["staff.ownership_transferred", "admin.tenant.ownership_transferred"] } } }));
    const b = await withOwnerRowHeld(() =>
      Promise.all([
        (async () => read(await selfTransfer(req(`/api/staff/${ids.c1}/transfer-ownership`, { password: PW }), { params: Promise.resolve({ id: ids.c1 }) })))(),
        op.run(),
      ]),
    );
    expect(await owners(ids.a), JSON.stringify(b.map((x) => x.status))).toHaveLength(1);
    expect(b.map((x) => x.status).sort()).toEqual([200, 409]);
    const auditAfter = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.a, action: { in: ["staff.ownership_transferred", "admin.tenant.ownership_transferred"] } } }));
    expect(auditAfter - auditBefore).toBe(1); // only the winner's record
    h.session = null;
  }, 300_000);
});
