// Operator step-up re-authentication (lane A, 6 Oct 2026) — audit
// OPERATOR-ADMIN-SECURITY 2026-10-05 Q5: "Operator re-authentication: none at
// the moment of action."
//
// Pins, against the real routes and lib/operator-step-up.ts:
//   - the step-up route needs a full MFA session AND a fresh code (spent);
//   - each Danger Zone route refuses without a grant, with NO tenant write;
//   - a grant is single use (replay refused), bound to operator + action +
//     target (substitution refused) and expires after 5 minutes;
//   - the development shared secret (sentinel operator) can never step up.
// Red on revert: remove a requireStepUp call and that route's "no grant" case
// fails; drop the nonce check in consumeStepUpGrant and "replay" fails.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "operator-step-up-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    ops: new Map<string, Record<string, unknown>>(),
    writes: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
    auditFail: false,
  };
});

const tableFactory = vi.hoisted(() => (ops: Map<string, Record<string, unknown>>) => {
  type Row = Record<string, unknown>;
  const matches = (row: Row, where: Row): boolean => {
    for (const [k, cond] of Object.entries(where)) {
      if (k === "OR") {
        if (!(cond as Row[]).some((c) => matches(row, c))) return false;
        continue;
      }
      const v = row[k];
      if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { lt?: number; gt?: Date };
        if (c.lt !== undefined && !(typeof v === "number" && v < c.lt)) return false;
        if (c.gt !== undefined && !(v instanceof Date && v.getTime() > c.gt.getTime())) return false;
        continue;
      }
      if (v !== cond) return false;
    }
    return true;
  };
  const apply = (row: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
      else row[k] = v;
    }
  };
  const findRow = (where: Row) => [...ops.values()].find((r) => matches(r, where));
  return {
    findUnique: async ({ where }: { where: Row }) => {
      const r = findRow(where);
      return r ? { ...r } : null;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = findRow(where);
      if (!r) throw new Error("not found");
      apply(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      let count = 0;
      for (const r of ops.values()) if (matches(r, where)) { apply(r, data); count++; }
      return { count };
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { operator: tableFactory(h.ops) } }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async (a: Record<string, unknown>) => {
    if (h.auditFail) throw new Error("audit store unavailable");
    h.audit.push(a);
  },
}));

// Club data the Danger Zone routes touch. Every WRITE is recorded.
const club = {
  tenant: {
    findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, name: "Club Name" }),
    // suspend (lane H, 6 Oct 2026)
    updateMany: async ({ where }: { where: { id: string } }) => { h.writes.push(`tenant.updateMany:${where.id}`); return { count: 1 }; },
  },
  user: {
    findFirst: async ({ where }: { where: { id?: string; role?: string } }) =>
      where.role === "owner"
        ? { id: "u-owner", email: "owner@example.test", name: "Owner", totpEnabled: true }
        : { id: where.id ?? "u-target", email: "staff@example.test", name: "Staff", role: "manager" },
    findUnique: async () => ({ passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1yJ0Q0m0m0m0m0m0m0m0m0m0m0m0m" }),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      h.writes.push(`user.update:${where.id}:${Object.keys(data).sort().join(",")}`);
      return { ...data };
    },
    updateMany: async () => { h.writes.push("user.updateMany"); return { count: 1 }; },
  },
  member: {
    findFirst: async ({ where }: { where: { id: string } }) => ({ id: where.id, email: "m@example.test", name: "Member", totpEnabled: true }),
    update: async ({ where }: { where: { id: string } }) => { h.writes.push(`member.update:${where.id}`); return {}; },
    findMany: async () => [],
    updateMany: async () => { h.writes.push("member.updateMany"); return { count: 0 }; },
  },
  passwordHistory: { create: async () => { h.writes.push("passwordHistory.create"); return {}; } },
};
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(club),
  withTenantContext: async <T,>(_id: string, fn: (tx: unknown) => Promise<T>) => fn(club),
}));

import { issueOperatorSession, issueOperatorEnrolmentSession } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, consumeStepUpGrant, type StepUpAction } from "@/lib/operator-step-up";

const ORIGIN = "http://localhost:3847";
let SECRET = "";

function seed(id = "op-noe") {
  SECRET = generateSecret();
  h.ops.set(id, {
    id, email: `${id}@example.test`, name: id, passwordHash: "x", role: "super_admin",
    totpEnabled: true, totpSecret: SECRET, totpLastUsedStep: null, failedLoginCount: 0,
    lockedUntil: null, sessionVersion: 0, stepUpNonceHash: null, stepUpExpiresAt: null,
  });
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}

type Case = { name: string; action: StepUpAction; file: string; tenant: string; body: Record<string, unknown>; target: string };
const CASES: Case[] = [
  { name: "force-password-reset", action: "owner.force_password_reset", file: "force-password-reset", tenant: "t-a", body: { reason: "verified by call-back" }, target: "t-a" },
  { name: "owner totp-reset", action: "owner.totp_reset", file: "totp-reset", tenant: "t-a", body: { reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a" },
  { name: "member-totp-reset", action: "member.totp_reset", file: "member-totp-reset", tenant: "t-a", body: { memberId: "m-1", reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a/m-1" },
  { name: "transfer-ownership", action: "tenant.transfer_ownership", file: "transfer-ownership", tenant: "t-a", body: { targetUserId: "u-target", reason: "verified by call-back", confirmName: "Club Name" }, target: "t-a/u-target" },
  // Review recommendation (lane H, 6 Oct 2026): suspending a club signs out every user and member of it.
  { name: "suspend", action: "tenant.suspend", file: "suspend", tenant: "t-a", body: { reason: "verified by call-back" }, target: "t-a" },
];

async function route(c: Case) {
  const mod = (await import(`@/app/api/admin/customers/[id]/${c.file}/route`)) as { POST: (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response> };
  return (grant: string | null, tenant = c.tenant, body = c.body) =>
    mod.POST(
      post(`/api/admin/customers/${tenant}/${c.file}`, body, grant ? { [STEP_UP_HEADER]: grant } : {}),
      { params: Promise.resolve({ id: tenant }) },
    );
}

beforeEach(() => {
  h.jar.clear();
  h.ops.clear();
  h.writes.length = 0;
  h.audit.length = 0;
  h.auditFail = false;
  seed();
  h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 0));
  process.env.MATFLOW_ADMIN_SECRET = "step-up-test-shared-secret";
});
afterEach(() => vi.useRealTimers());

describe.each(CASES)("$name", (c) => {
  it("refuses with no grant, and writes nothing to the club", async () => {
    const res = await (await route(c))(null);
    expect(res.status).toBe(403);
    expect((await res.json()).stepUpRequired).toBe(true);
    expect(h.writes).toEqual([]);
  });

  it("proceeds with a valid grant, once; the replay is refused with no further write", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const call = await route(c);
    const ok = await call(grant);
    expect(ok.status).toBe(200);
    const after = [...h.writes];
    expect(after.length).toBeGreaterThan(0);

    const replay = await call(grant);
    expect(replay.status).toBe(403);
    expect(h.writes).toEqual(after);
  });

  it("refuses a grant for the same action on ANOTHER target", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-other" + c.target.slice(3) });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses a grant for a DIFFERENT action on the same target", async () => {
    const other: StepUpAction = c.action === "owner.totp_reset" ? "owner.force_password_reset" : "owner.totp_reset";
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: other, targetId: c.target });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses an expired grant (older than 5 minutes)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    // Keep the session valid at the new time.
    h.jar.set("matflow_op_session", issueOperatorSession("op-noe", 0));
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses another operator's grant", async () => {
    seed("op-other");
    const { grant } = await issueStepUpGrant({ operatorId: "op-other", action: c.action, targetId: c.target });
    const res = await (await route(c))(grant);
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("refuses the development shared secret (no named operator, no authenticator)", async () => {
    h.jar.clear();
    h.jar.set("matflow_admin", "step-up-test-shared-secret");
    const res = await (await route(c))("anything");
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });
});

describe("substitution of the person inside the club", () => {
  it("a member-totp-reset grant for member m-1 cannot reset member m-2", async () => {
    const c = CASES[2];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-a/m-1" });
    const res = await (await route(c))(grant, "t-a", { ...c.body, memberId: "m-2" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });

  it("a transfer grant to u-target cannot hand the club to u-someone-else", async () => {
    const c = CASES[3];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: "t-a/u-target" });
    const res = await (await route(c))(grant, "t-a", { ...c.body, targetUserId: "u-someone-else" });
    expect(res.status).toBe(403);
    expect(h.writes).toEqual([]);
  });
});

describe("single use across instances", () => {
  it("two instances spending the same grant at once: exactly one succeeds", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.totp_reset", targetId: "t-a" });
    const args = { token: grant, operatorId: "op-noe", action: "owner.totp_reset" as const, targetId: "t-a" };
    const results = await Promise.all([consumeStepUpGrant(args), consumeStepUpGrant(args)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("issuing a new grant supersedes the outstanding one", async () => {
    const first = await issueStepUpGrant({ operatorId: "op-noe", action: "owner.totp_reset", targetId: "t-a" });
    await issueStepUpGrant({ operatorId: "op-noe", action: "owner.totp_reset", targetId: "t-a" });
    const r = await consumeStepUpGrant({ token: first.grant, operatorId: "op-noe", action: "owner.totp_reset", targetId: "t-a" });
    expect(r).toEqual({ ok: false, reason: "spent" });
  });

  it("the force-password-reset temporary password carries a 72-hour expiry", async () => {
    const c = CASES[0];
    const { grant } = await issueStepUpGrant({ operatorId: "op-noe", action: c.action, targetId: c.target });
    const before = Date.now();
    const res = await (await route(c))(grant);
    const data = (await res.json()) as { tempPasswordExpiresAt: string };
    const at = new Date(data.tempPasswordExpiresAt).getTime();
    expect(at - before).toBeGreaterThanOrEqual(72 * 3600 * 1000 - 1000);
    expect(at - before).toBeLessThanOrEqual(72 * 3600 * 1000 + 5000);
    expect(h.writes.some((w) => w.startsWith("user.update:u-owner:") && w.includes("tempPasswordExpiresAt"))).toBe(true);
  });
});

describe("POST /api/admin/auth/step-up", () => {
  async function stepUp(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/admin/auth/step-up/route");
    return POST(post("/api/admin/auth/step-up", body));
  }

  it("issues a grant for a fresh code, and the same code cannot buy a second grant", async () => {
    const code = generateSync({ secret: SECRET });
    const first = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(first.status).toBe(200);
    const { grant } = (await first.json()) as { grant: string };
    expect(typeof grant).toBe("string");
    expect(h.audit.map((a) => a.action)).toContain("admin.operator.step_up");

    const again = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(again.status).toBe(401);
  });

  it("D5: the issuance row is DURABLE (awaited, throws), written before the grant exists", async () => {
    const code = generateSync({ secret: SECRET });
    const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(res.status).toBe(200);
    const row = h.audit.find((a) => a.action === "admin.operator.step_up");
    expect(row).toMatchObject({ durable: true, tenantId: null, entityId: "op-noe" });
  });

  it("D5: if the issuance row cannot be written, no grant is issued or returned", async () => {
    h.auditFail = true;
    const code = generateSync({ secret: SECRET });
    const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.grant).toBeUndefined();
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("refuses a wrong code", async () => {
    expect((await stepUp({ action: "owner.totp_reset", targetId: "t-a", code: "000000" })).status).toBe(401);
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("refuses without a full session: enrolment cookie, shared secret, nothing", async () => {
    const code = generateSync({ secret: SECRET });
    for (const jar of [
      { matflow_op_enrol: issueOperatorEnrolmentSession("op-noe", 0) },
      { matflow_admin: "step-up-test-shared-secret" },
      {},
    ]) {
      h.jar = new Map(Object.entries(jar));
      const res = await stepUp({ action: "owner.totp_reset", targetId: "t-a", code });
      expect(res.status).toBe(401);
    }
    expect(h.ops.get("op-noe")!.stepUpNonceHash).toBeNull();
  });

  it("refuses a cross-origin request", async () => {
    const { POST } = await import("@/app/api/admin/auth/step-up/route");
    const res = await POST(new Request("https://matflow.studio/api/admin/auth/step-up", {
      method: "POST",
      headers: { origin: "https://evil.matflow.studio", host: "matflow.studio", "content-type": "application/json" },
      body: JSON.stringify({ action: "owner.totp_reset", targetId: "t-a", code: generateSync({ secret: SECRET }) }),
    }));
    expect(res.status).toBe(403);
  });
});

describe("suspend: step-up on POST only (lane H, 6 Oct 2026)", () => {
  it("DELETE (un-suspend, the recovery direction) does not ask for a step-up grant", async () => {
    const mod = (await import("@/app/api/admin/customers/[id]/suspend/route")) as { DELETE: (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response> };
    const res = await mod.DELETE(
      new Request(ORIGIN + "/api/admin/customers/t-a/suspend", { method: "DELETE", headers: { origin: ORIGIN, host: "localhost:3847" } }),
      { params: Promise.resolve({ id: "t-a" }) },
    );
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    expect(body.stepUpRequired).toBeUndefined();
  });

  it("tenant.suspend is a step-up action", async () => {
    const { STEP_UP_ACTIONS } = await import("@/lib/operator-step-up");
    expect(STEP_UP_ACTIONS).toContain("tenant.suspend");
  });
});
