// Security lane B (9 Oct 2026) — role-by-route matrix with positive controls
// (SEC-018), object-level ID swaps across clubs (SEC-017), property-level mass
// assignment (SEC-019) and list disclosure (SEC-022) for the high-impact routes
// in lane B's scope. TEST branch only, synthetic data, both DB roles.
//
// For every route × role (owner, manager, admin, coach, member, anonymous):
//   - an ALLOWED role gets a 2xx and the intended effect (positive control —
//     a refusal elsewhere then means "refused", not "route broken");
//   - a DENIED role gets 401 (anonymous) or 403 — never 404/500/redirect — and
//     the target row is byte-identical afterwards;
//   - club A's owner naming club B's object gets 404 and club B's row is
//     byte-identical (object-level).
// Expected allow-lists come from the route gates (static inventory in
// docs/security/evidence/B/05-authorization-coverage.md) and the runbooks.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-b-role-matrix-db-test-secret-0123456789abcdef";
  return { session: null as null | Record<string, unknown> };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.54",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as membersList, POST as memberCreate } from "@/app/api/members/route";
import { PATCH as memberPatch, DELETE as memberDelete } from "@/app/api/members/[id]/route";
import { POST as memberUnlock } from "@/app/api/members/[id]/unlock/route";
import { POST as memberTotpReset } from "@/app/api/members/[id]/totp-reset/route";
import { POST as staffCreate } from "@/app/api/staff/route";
import { PATCH as staffPatch } from "@/app/api/staff/[id]/route";
import { POST as staffTotpReset } from "@/app/api/staff/[id]/totp-reset/route";
import { POST as transferOwnership } from "@/app/api/staff/[id]/transfer-ownership/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE_DB = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();
const E = (who: string) => `${SLUG}-${who}@example.test`;
const ORIGIN = "http://localhost:3847";
const PW = `Synthetic-${SLUG}-Aa1`;

type Role = "owner" | "manager" | "admin" | "coach" | "member" | "anonymous" | "support";
const ROLES: Role[] = ["owner", "manager", "admin", "coach", "member", "anonymous"];
/** A read-only support session: the operator acting as club A's owner (impersonatedBy set). */
const MUTATOR_ROLES: Role[] = [...ROLES, "support"];

const req = (url: string, method: string, body?: unknown) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const P = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!HAS_DB)(`role-by-route matrix, lane B routes (${ROLE_DB} role)`, () => {
  const club = { a: "", b: "" };
  const actors: Record<"a" | "b", Partial<Record<Role, { id: string; memberId?: string }>>> = { a: {}, b: {} };
  let n = 0;

  const sessionAs = (role: Role, c: "a" | "b" = "a") => {
    if (role === "anonymous") return null;
    if (role === "support") return { user: { id: actors[c].owner!.id, tenantId: club[c], role: "owner", totpEnabled: true, sessionVersion: 0, mustChangePassword: false, impersonatedBy: "secB-operator" } };
    const who = actors[c][role]!;
    if (role === "member") return { user: { id: who.id, memberId: who.id, tenantId: club[c], role: "member", sessionVersion: 0 } };
    return { user: { id: who.id, tenantId: club[c], role, totpEnabled: true, sessionVersion: 0, mustChangePassword: false } };
  };
  const newMember = (c: "a" | "b", extra: Record<string, unknown> = {}) =>
    withRlsBypass((tx) => tx.member.create({ data: { tenantId: club[c], name: `Target ${++n}`, email: E(`m${n}`), ...extra }, select: { id: true } })).then((m) => m.id);
  const newStaff = (c: "a" | "b", role = "coach", extra: Record<string, unknown> = {}) =>
    withRlsBypass((tx) => tx.user.create({ data: { tenantId: club[c], name: `Staff ${++n}`, email: E(`s${n}`), role, passwordHash: "staff-hash", ...extra }, select: { id: true } })).then((u) => u.id);
  const memberRow = (id: string) => withRlsBypass((tx) => tx.member.findUnique({ where: { id } }));
  const userRow = (id: string) => withRlsBypass((tx) => tx.user.findUnique({ where: { id } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const c of ["a", "b"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} Club ${c}`, slug: `${SLUG}-${c}`, onboardingCompleted: true } });
        club[c] = t.id;
        for (const role of ["owner", "manager", "admin", "coach"] as const) {
          actors[c][role] = await tx.user.create({ data: { tenantId: t.id, email: E(`${c}-${role}`), name: `${c} ${role}`, role, passwordHash: "x", totpEnabled: true, totpSecret: "s" }, select: { id: true } });
        }
        actors[c].member = await tx.member.create({ data: { tenantId: t.id, email: E(`${c}-member`), name: `${c} member`, passwordHash: "x" }, select: { id: true } });
      }
    });
  }, 120_000);

  afterAll(async () => {
    h.session = null;
    await new Promise((r) => setTimeout(r, 750));
    for (const tenantId of [club.a, club.b].filter(Boolean)) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.passwordHistory.deleteMany({ where: { user: { tenantId } } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      }, { timeout: 60_000 });
    }
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { slug: { startsWith: SLUG } } }),
      users: await tx.user.count({ where: { email: { startsWith: SLUG } } }),
      members: await tx.member.count({ where: { email: { startsWith: SLUG } } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, members: 0 });
  }, 120_000);

  type Spec = {
    route: string;
    allowed: Role[];
    /** A fresh target in club c (so a positive control never disturbs the next cell). */
    target: (c: "a" | "b") => Promise<string>;
    call: (id: string) => Promise<Response>;
    snap: (id: string) => Promise<unknown>;
    /** The allowed role's effect, checked on the database. */
    effect: (id: string, before: unknown) => Promise<void>;
    swap?: boolean;
  };

  const SPECS: Spec[] = [
    {
      route: "PATCH /api/members/[id] (rename)",
      allowed: ["owner", "manager", "admin"],
      target: (c) => newMember(c),
      call: (id) => memberPatch(req(`/api/members/${id}`, "PATCH", { name: "Renamed By Matrix" }), P(id)),
      snap: memberRow,
      effect: async (id) => expect((await memberRow(id))?.name).toBe("Renamed By Matrix"),
      swap: true,
    },
    {
      route: "DELETE /api/members/[id]?probe=1 (owner only)",
      allowed: ["owner"],
      target: (c) => newMember(c),
      call: (id) => memberDelete(req(`/api/members/${id}?probe=1`, "DELETE"), P(id)),
      snap: memberRow,
      effect: async (id) => expect(await memberRow(id)).not.toBeNull(), // a probe deletes nothing
      swap: true,
    },
    {
      route: "POST /api/members/[id]/unlock",
      allowed: ["owner", "manager"],
      target: (c) => newMember(c, { failedLoginCount: 7, lockedUntil: new Date(Date.now() + 3_600_000) }),
      call: (id) => memberUnlock(req(`/api/members/${id}/unlock`, "POST", {}), P(id)),
      snap: memberRow,
      effect: async (id) => expect(await memberRow(id)).toMatchObject({ failedLoginCount: 0, lockedUntil: null }),
      swap: true,
    },
    {
      route: "POST /api/members/[id]/totp-reset",
      allowed: ["owner", "manager"],
      target: (c) => newMember(c, { totpEnabled: true, totpSecret: "member-secret", passwordHash: "member-hash" }),
      call: (id) => memberTotpReset(req(`/api/members/${id}/totp-reset`, "POST", { reason: "lane B matrix synthetic" }), P(id)),
      snap: memberRow,
      effect: async (id) => expect(await memberRow(id)).toMatchObject({ totpEnabled: false, totpSecret: null }),
      swap: true,
    },
    {
      route: "PATCH /api/staff/[id] (rename)",
      allowed: ["owner"],
      target: (c) => newStaff(c),
      call: (id) => staffPatch(req(`/api/staff/${id}`, "PATCH", { name: "Staff Renamed By Matrix" }), P(id)),
      snap: userRow,
      effect: async (id) => expect((await userRow(id))?.name).toBe("Staff Renamed By Matrix"),
      swap: true,
    },
    {
      route: "POST /api/staff/[id]/totp-reset",
      allowed: ["owner"],
      target: (c) => newStaff(c, "coach", { totpEnabled: true, totpSecret: "staff-secret" }),
      call: (id) => staffTotpReset(req(`/api/staff/${id}/totp-reset`, "POST", { reason: "lane B matrix synthetic" }), P(id)),
      snap: userRow,
      effect: async (id) => expect(await userRow(id)).toMatchObject({ totpEnabled: false, totpSecret: null }),
      swap: true,
    },
    {
      route: "POST /api/staff/[id]/transfer-ownership (denials; positive control in sec-b-ownership-transfer-db)",
      allowed: [],
      target: (c) => newStaff(c, "manager"),
      call: (id) => transferOwnership(req(`/api/staff/${id}/transfer-ownership`, "POST", { password: "wrong-password-for-matrix" }), P(id)),
      snap: userRow,
      effect: async () => {},
    },
  ];

  for (const spec of SPECS) {
    for (const role of MUTATOR_ROLES) {
      const allowed = spec.allowed.includes(role);
      it(`${spec.route} — ${role}: ${allowed ? "ALLOWED (positive control)" : "refused, row unchanged"}`, async () => {
        const id = await spec.target("a");
        const before = await spec.snap(id);
        h.session = sessionAs(role);
        const res = await spec.call(id);
        h.session = null;
        const text = await res.text();
        if (allowed) {
          expect(res.status, text).toBeGreaterThanOrEqual(200);
          expect(res.status, text).toBeLessThan(300);
          await spec.effect(id, before);
        } else {
          // owner on transfer with a wrong password is a 403 too (refused, nothing written)
          expect(res.status, text).toBe(role === "anonymous" ? 401 : 403);
          expect(await spec.snap(id)).toEqual(before);
        }
      });
    }
    if (spec.swap) {
      it(`${spec.route} — object swap: club A's owner on club B's object is 404, club B row unchanged`, async () => {
        const id = await spec.target("b");
        const before = await spec.snap(id);
        h.session = sessionAs("owner", "a");
        const res = await spec.call(id);
        h.session = null;
        expect(res.status, await res.text()).toBe(404);
        expect(await spec.snap(id)).toEqual(before);
      });
    }
  }

  it("POST /api/staff (create) — only the owner; every other role refused and nothing created", async () => {
    for (const role of ROLES) {
      const email = E(`create-${role}`);
      h.session = sessionAs(role);
      const res = await staffCreate(req("/api/staff", "POST", { name: `Created by ${role}`, email, role: "coach", password: PW }));
      h.session = null;
      const made = await withRlsBypass((tx) => tx.user.count({ where: { email } }));
      if (role === "owner") {
        expect(res.status, await res.text()).toBe(201);
        expect(made).toBe(1);
      } else {
        expect(res.status, `${role}`).toBe(role === "anonymous" ? 401 : 403);
        expect(made, role).toBe(0);
      }
    }
  });

  it("POST /api/members (create) — owner, manager, admin; coach/member/anonymous refused and nothing created", async () => {
    for (const role of ROLES) {
      const email = E(`mcreate-${role}`);
      h.session = sessionAs(role);
      const res = await memberCreate(req("/api/members", "POST", { name: `Member by ${role}`, email }));
      h.session = null;
      const made = await withRlsBypass((tx) => tx.member.count({ where: { email } }));
      if (["owner", "manager", "admin"].includes(role)) {
        expect(res.status, `${role} ${await res.text()}`).toBeLessThan(300);
        expect(made, role).toBe(1);
      } else {
        expect(res.status, role).toBe(role === "anonymous" ? 401 : 403);
        expect(made, role).toBe(0);
      }
    }
  });

  it("SEC-019 mass assignment: member create/edit ignore tenantId, password, session, MFA, import identity and login-capability keys", async () => {
    const email = E("mass");
    h.session = sessionAs("owner");
    const created = await memberCreate(req("/api/members", "POST", {
      name: "Mass Assign", email, tenantId: club.b, passwordHash: "attacker-hash", sessionVersion: 99, totpEnabled: true, totpSecret: "attacker",
      externalRef: "teamup:forged", failedLoginCount: 0, unverifiedEmail: "x@example.test", importJobId: "forged", billedBy: "teamup",
    }));
    expect(created.status, await created.text()).toBeLessThan(300);
    const row = await withRlsBypass((tx) => tx.member.findFirstOrThrow({ where: { email } }));
    expect(row).toMatchObject({ tenantId: club.a, passwordHash: null, sessionVersion: 0, totpEnabled: false, totpSecret: null, externalRef: null, unverifiedEmail: null, importJobId: null, billedBy: "matflow" });
    const before = await memberRow(row.id);
    const patched = await memberPatch(req(`/api/members/${row.id}`, "PATCH", {
      name: "Mass Assign 2", tenantId: club.b, passwordHash: "attacker-hash", sessionVersion: 99, totpEnabled: true, totpSecret: "attacker", externalRef: "teamup:forged", parentMemberId: actors.b.member!.id,
    }), P(row.id));
    h.session = null;
    expect(patched.status, await patched.text()).toBeLessThan(500);
    const after = await memberRow(row.id);
    // Whatever the status, no protected column moved.
    for (const k of ["tenantId", "passwordHash", "sessionVersion", "totpEnabled", "totpSecret", "externalRef", "parentMemberId"] as const) {
      expect(after?.[k], k).toEqual(before?.[k]);
    }
  });

  it("SEC-022 list disclosure: GET /api/members as club A staff never returns club B rows; a member and anonymous are refused", async () => {
    const bId = await newMember("b", { name: `${STAMP} club-b-only` });
    for (const role of ROLES) {
      h.session = sessionAs(role);
      const res = await membersList(req(`/api/members?q=${encodeURIComponent(STAMP)}`, "GET"));
      h.session = null;
      const text = await res.text();
      if (["owner", "manager", "admin", "coach"].includes(role)) {
        expect(res.status, `${role} ${text.slice(0, 200)}`).toBe(200);
        expect(text).not.toContain(bId);
        expect(text).not.toContain("club-b-only");
      } else {
        expect(res.status, role).toBe(role === "anonymous" ? 401 : 403);
        expect(text).not.toContain(bId);
      }
    }
  });
});
