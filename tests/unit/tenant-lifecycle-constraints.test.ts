// Tenant lifecycle constraints (operator security audit, 5 Oct 2026, Q8).
//
// What suspension, review mode and soft-deletion actually constrain, pinned
// against the route code with a mocked database. Three kinds of test live here:
//
//   1. Guarantees the product relies on (sessions die on suspend/soft-delete,
//      crons skip a suspended or deleted club, review mode refuses deletion
//      before any side effect, review mode does NOT block sign-in).
//   2. "CURRENT BEHAVIOUR (open finding)" pins: behaviour the audit reported as
//      a gap. They pass today on purpose. When the gap is fixed the pin goes
//      red, and the right edit is to flip its expectation — not to delete it.
//   3. The restore-vs-purge race, pinned the same way.
//
// Each transaction opened through withRlsBypass / withTenantContext gets its
// own id, so "these writes commit together" is checked, not assumed.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const DEFAULTS: Record<string, () => unknown> = {
    findMany: () => [],
    findUnique: () => null,
    findFirst: () => null,
    deleteMany: () => ({ count: 0 }),
    updateMany: () => ({ count: 0 }),
    createMany: () => ({ count: 0 }),
    update: () => ({}),
    delete: () => ({}),
    create: () => ({}),
    count: () => 0,
  };
  const calls: Array<{ tx: number; model: string; method: string; args: unknown[] }> = [];
  // Per-model, per-method override. Absent = the default above.
  const impl: Record<string, Record<string, (...a: unknown[]) => unknown>> = {};
  let nextTx = 0;
  function makeTx(tx: number) {
    return new Proxy({} as Record<string, unknown>, {
      get(_t, model: string) {
        if (model === "$executeRaw" || model === "$queryRaw") return async () => 0;
        return new Proxy({} as Record<string, unknown>, {
          get(_m, method: string) {
            return async (...args: unknown[]) => {
              calls.push({ tx, model, method, args });
              const f = impl[model]?.[method];
              if (f) return f(...args);
              const d = DEFAULTS[method];
              return d ? d() : undefined;
            };
          },
        });
      },
    });
  }
  return {
    calls,
    impl,
    makeTx,
    openTx: () => makeTx(++nextTx),
    reset() {
      calls.length = 0;
      for (const k of Object.keys(impl)) delete impl[k];
      nextTx = 0;
    },
  };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(h.openTx()),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(h.openTx()),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.makeTx(0) }));

const m = vi.hoisted(() => ({
  cancelAtPeriodEnd: vi.fn(),
  logAudit: vi.fn(),
  generateMonthlyReport: vi.fn(),
  setImpersonationCookie: vi.fn(),
  cascade: vi.fn(),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ authed: true, operatorId: "op_1", operatorEmail: "operator@example.test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
  checkCronAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: m.logAudit }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: m.cancelAtPeriodEnd }));
vi.mock("@/lib/stripe/reconcile", () => ({
  runStripeReconciliation: async () => ({ ok: true, tenantsChecked: 0, eventsScanned: 0, missingCount: 0, missing: [], errors: [] }),
}));
vi.mock("@/lib/ai-causal-report", () => ({ generateMonthlyReport: m.generateMonthlyReport }));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: m.cascade }));
vi.mock("@vercel/blob", () => ({ del: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/impersonation", () => ({
  setImpersonationCookie: m.setImpersonationCookie,
  clearImpersonationCookie: vi.fn(),
  readImpersonationCookie: vi.fn().mockResolvedValue(null),
}));

import { tenantAdmission } from "@/lib/tenant-admission";
import * as suspendRoute from "@/app/api/admin/customers/[id]/suspend/route";
import * as softDeleteRoute from "@/app/api/admin/customers/[id]/soft-delete/route";
import { POST as impersonateStart } from "@/app/api/admin/impersonate/route";
import { GET as classInstancesCron } from "@/app/api/cron/class-instances/route";
import { GET as monthlyReportsCron } from "@/app/api/cron/monthly-reports/route";
import { GET as retentionCron } from "@/app/api/cron/retention/route";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-05T03:30:00.000Z");
const SECRET = "test-cron-secret";

type TenantRow = {
  id: string;
  name: string;
  subscriptionStatus: string;
  deletedAt: Date | null;
  reviewLockedAt: Date | null;
  stripeAccountId: string | null;
  timezone: string;
  logoUrl: string | null;
};

let tenants: TenantRow[] = [];

function tenant(over: Partial<TenantRow> & { id: string }): TenantRow {
  return {
    name: `Club ${over.id}`,
    subscriptionStatus: "active",
    deletedAt: null,
    reviewLockedAt: null,
    stripeAccountId: null,
    timezone: "Europe/London",
    logoUrl: null,
    ...over,
  };
}

// A deliberately small evaluator for the tenant `where` clauses these routes
// use, so "the cron skips a suspended club" is tested against rows, not by
// string-matching the query.
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date || typeof cond !== "object") return v === cond;
    const c = cond as { in?: unknown[]; not?: unknown; lt?: Date };
    if (c.in && !c.in.includes(v)) return false;
    if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
    if (c.lt && !(v instanceof Date && v.getTime() < c.lt.getTime())) return false;
    return true;
  });
}

function installTenantTable() {
  h.impl.tenant = {
    findMany: (args: unknown) =>
      tenants.filter((t) => matches(t, (args as { where?: Record<string, unknown> })?.where)),
    findUnique: (args: unknown) => {
      const id = (args as { where: { id?: string } }).where.id;
      return tenants.find((t) => t.id === id) ?? null;
    },
  };
}

const writes = (model: string, method: string) => h.calls.filter((c) => c.model === model && c.method === method);

function adminReq(method: string, body?: unknown) {
  return new Request("https://matflow.studio/api/admin/x", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const cronReq = (path: string) =>
  new Request(`https://matflow.studio${path}`, { headers: { authorization: `Bearer ${SECRET}` } });

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  process.env.ANTHROPIC_API_KEY = "test-not-a-real-key";
  tenants = [];
  installTenantTable();
  m.cancelAtPeriodEnd.mockResolvedValue({ ok: true, cancelAt: null });
  m.generateMonthlyReport.mockResolvedValue({ ok: true });
  m.cascade.mockResolvedValue({ kind: "ok", name: "Member" });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Sign-in admission ───────────────────────────────────────────────────────

describe("admission: which lifecycle states keep people out", () => {
  it("suspended and soft-deleted refuse; review mode does not (it is not an admission state)", () => {
    expect(tenantAdmission({ subscriptionStatus: "suspended", deletedAt: null }).admits).toBe(false);
    expect(tenantAdmission({ subscriptionStatus: "active", deletedAt: new Date() }).admits).toBe(false);
    // A review-locked club is an active club whose reviewLockedAt is set — the
    // admission helper never looks at it, so owners and members still sign in.
    const reviewLocked = { subscriptionStatus: "active", deletedAt: null, reviewLockedAt: new Date() };
    expect(tenantAdmission(reviewLocked).admits).toBe(true);
  });
});

// ─── Suspension ──────────────────────────────────────────────────────────────

describe("suspend: existing sessions are cut off", () => {
  it("flips the status and bumps every User AND Member sessionVersion in ONE transaction", async () => {
    tenants = [tenant({ id: "t1" })];
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(res.status).toBe(200);

    const [statusFlip] = writes("tenant", "update");
    const [userBump] = writes("user", "updateMany");
    const [memberBump] = writes("member", "updateMany");
    expect(statusFlip.args[0]).toEqual({ where: { id: "t1" }, data: { subscriptionStatus: "suspended" } });
    expect(userBump.args[0]).toEqual({ where: { tenantId: "t1" }, data: { sessionVersion: { increment: 1 } } });
    expect(memberBump.args[0]).toEqual({ where: { tenantId: "t1" }, data: { sessionVersion: { increment: 1 } } });
    expect(new Set([statusFlip.tx, userBump.tx, memberBump.tx]).size).toBe(1);
  });

  it("asks Stripe to stop renewing each member subscription (period end), before the lock", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = {
      findMany: () => [
        { id: "m1", stripeSubscriptionId: "sub_1" },
        { id: "m2", stripeSubscriptionId: "sub_2" },
      ],
    };
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(await res.json()).toMatchObject({ ok: true, stripeCancelled: 2, stripeFailed: 0 });
    expect(m.cancelAtPeriodEnd).toHaveBeenCalledTimes(2);
  });

  it("CURRENT BEHAVIOUR (open finding): a Stripe failure does not stop the suspension — billing may continue", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = { findMany: () => [{ id: "m1", stripeSubscriptionId: "sub_1" }] };
    m.cancelAtPeriodEnd.mockResolvedValue({ ok: false, error: "stripe down" });
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(await res.json()).toMatchObject({ ok: true, stripeCancelled: 0, stripeFailed: 1 });
    expect(writes("tenant", "update")).toHaveLength(1);
  });

  it("CURRENT BEHAVIOUR (open finding): reactivation sets 'active' whatever the club was, and never undoes the period-end cancellations", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "suspended", stripeAccountId: "acct_1" })];
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(200);
    expect(writes("tenant", "update")[0].args[0]).toEqual({ where: { id: "t1" }, data: { subscriptionStatus: "active" } });
    // Nothing re-enables the subscriptions suspension set to cancel.
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(writes("member", "findMany")).toHaveLength(0);
  });
});

// ─── Soft-deletion and review mode ───────────────────────────────────────────

describe("soft-delete: review mode refuses it; otherwise sessions die with it", () => {
  it("a review-locked club cannot be soft-deleted, and nothing is written or cancelled", async () => {
    tenants = [tenant({ id: "t1", reviewLockedAt: new Date("2026-10-01"), stripeAccountId: "acct_1" })];
    h.impl.tenant.findUnique = (args: unknown) => {
      const id = (args as { where: { id: string } }).where.id;
      const t = tenants.find((x) => x.id === id);
      return t ? { ...t, reviewSnapshotAt: null, reviewNote: null } : null;
    };
    const res = await softDeleteRoute.POST(
      adminReq("POST", { reason: "Closing down", confirmName: "Club t1" }),
      params("t1"),
    );
    expect(res.status).toBe(423);
    expect(h.calls.filter((c) => /update|delete|create/i.test(c.method))).toHaveLength(0);
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("stamps deletedAt and bumps User AND Member sessionVersion in ONE transaction", async () => {
    tenants = [tenant({ id: "t1" })];
    const res = await softDeleteRoute.POST(
      adminReq("POST", { reason: "Closing down", confirmName: "Club t1" }),
      params("t1"),
    );
    expect(res.status).toBe(200);
    const [stamp] = writes("tenant", "update");
    const [userBump] = writes("user", "updateMany");
    const [memberBump] = writes("member", "updateMany");
    expect(stamp.args[0]).toEqual({ where: { id: "t1" }, data: { deletedAt: NOW } });
    expect(userBump.args[0]).toMatchObject({ data: { sessionVersion: { increment: 1 } } });
    expect(memberBump.args[0]).toMatchObject({ data: { sessionVersion: { increment: 1 } } });
    expect(new Set([stamp.tx, userBump.tx, memberBump.tx]).size).toBe(1);
  });

  it("CURRENT BEHAVIOUR (open finding): restore has no grace-window check and an unconditional write", async () => {
    // Soft-deleted 40 days ago: past the 30-day window, so the retention cron
    // may already have purged part of it. Restore still says yes.
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(200);
    expect(writes("tenant", "update")[0].args[0]).toEqual({ where: { id: "t1" }, data: { deletedAt: null } });
  });
});

// ─── Background jobs ─────────────────────────────────────────────────────────

describe("crons skip suspended and soft-deleted clubs", () => {
  beforeEach(() => {
    tenants = [
      tenant({ id: "active" }),
      tenant({ id: "trial", subscriptionStatus: "trial" }),
      tenant({ id: "suspended", subscriptionStatus: "suspended" }),
      tenant({ id: "deleted", deletedAt: new Date(NOW.getTime() - DAY_MS) }),
    ];
  });

  it("class-instances generates nothing for a suspended or deleted club", async () => {
    const res = await classInstancesCron(cronReq("/api/cron/class-instances"));
    expect(res.status).toBe(200);
    const scoped = writes("class", "findMany").map((c) => (c.args[0] as { where: { tenantId: string } }).where.tenantId);
    expect(scoped.sort()).toEqual(["active", "trial"]);
  });

  it("monthly-reports writes no report for a suspended or deleted club", async () => {
    const res = await monthlyReportsCron(cronReq("/api/cron/monthly-reports"));
    expect(res.status).toBe(200);
    const reported = m.generateMonthlyReport.mock.calls.map((c) => (c[0] as { tenantId: string }).tenantId);
    expect(reported.sort()).toEqual(["active", "trial"]);
  });
});

// ─── Restore vs purge ────────────────────────────────────────────────────────

describe("retention purge vs an operator restore", () => {
  it("CURRENT BEHAVIOUR (open finding): a restore that commits mid-purge does not stop the purge — the tenant row is still deleted", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    // The operator's restore commits while the cron is draining members.
    h.impl.member = {
      findMany: (args: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where;
        if (where.parentMemberId) tenants[0].deletedAt = null;
        return [];
      },
    };
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(tenants[0].deletedAt).toBeNull(); // the restore really did land

    // No step after the candidate query re-reads deletedAt …
    const tenantReads = h.calls.filter((c) => c.model === "tenant" && /^find/.test(c.method));
    const rereadsDeletedAt = tenantReads.some(
      (c) => JSON.stringify(c.args[0] ?? {}).includes("deletedAt") && c !== tenantReads[0],
    );
    expect(rereadsDeletedAt).toBe(false);
    // … and the final delete is unconditional, so the restored club is erased.
    expect(writes("tenant", "delete").map((c) => c.args[0])).toEqual([{ where: { id: "t1" } }]);
  });

  it("purge steps run as separate transactions (a partial purge commits and survives a later restore)", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    await retentionCron(cronReq("/api/cron/retention"));
    const taskTx = writes("task", "findMany")[0]?.tx;
    const tenantDeleteTx = writes("tenant", "delete")[0]?.tx;
    expect(taskTx).toBeDefined();
    expect(tenantDeleteTx).toBeDefined();
    expect(taskTx).not.toBe(tenantDeleteTx);
  });
});

// ─── Impersonation ───────────────────────────────────────────────────────────

describe("impersonation into a closed club", () => {
  it("CURRENT BEHAVIOUR (open finding): an operator can start impersonating a user of a suspended or deleted club", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "suspended", deletedAt: new Date() })];
    h.impl.user = {
      findUnique: () => ({ id: "u1", tenantId: "t1", email: "owner@example.test", name: "Owner", role: "owner" }),
    };
    const res = await impersonateStart(adminReq("POST", { targetUserId: "u1", reason: "Support ticket 42" }));
    expect(res.status).toBe(200);
    expect(m.setImpersonationCookie).toHaveBeenCalledWith(expect.objectContaining({ targetTenantId: "t1" }));
    // The tenant's status is never read on the way in.
    expect(h.calls.filter((c) => c.model === "tenant")).toHaveLength(0);
  });
});
