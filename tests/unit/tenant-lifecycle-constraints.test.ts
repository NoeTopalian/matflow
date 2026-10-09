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
import { Prisma } from "@prisma/client";

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
  requireStepUp: vi.fn(),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ authed: true, named: true, operatorId: "op_1", operatorEmail: "operator@example.test" }),
}));
// Lane B (6 Oct 2026): starting support needs the named operator's live MFA session (its sessionVersion
// binds the support session).
vi.mock("@/lib/operator-auth", () => ({
  OP_SESSION_COOKIE: "matflow_op_session",
  resolveOperatorFromCookie: async () => ({ id: "op_1", email: "operator@example.test", name: "Op", sessionVersion: 4 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
  checkCronAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: m.logAudit, auditLogRetentionWhere: () => ({ createdAt: { lt: new Date(0) } }) }));
// Lane D (6 Oct 2026): soft-delete demands a step-up grant. Passed by default
// so the lifecycle stays the subject; refused in its own test below.
// Lane C (9 Oct 2026): requireStepUp returns the verified grant (or a
// refusal); consumeStepUpGrant spends it inside the route's transaction.
const GRANT = { operatorId: "op_1", sessionVersion: 4, action: "tenant.soft_delete", targetId: "t1", tenantId: "t1", versionDigest: "v", requestId: "rq-test" };
vi.mock("@/lib/operator-step-up", () => ({
  requireStepUp: m.requireStepUp,
  consumeStepUpGrant: async () => ({ kind: "spent" }),
  refuseStepUp: () => new Response(null, { status: 403 }),
  StepUpRefusedError: class StepUpRefusedError extends Error {},
  stepUpTarget: (t: string, s?: string) => (s ? `${t}/${s}` : t),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: m.cancelAtPeriodEnd }));
vi.mock("@/lib/stripe/reconcile", () => ({
  runStripeReconciliation: async () => ({ ok: true, tenantsChecked: 0, eventsScanned: 0, missingCount: 0, missing: [], errors: [] }),
}));
vi.mock("@/lib/ai-causal-report", () => ({ generateMonthlyReport: m.generateMonthlyReport }));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: m.cascade }));
vi.mock("@vercel/blob", () => ({ del: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/impersonation", () => ({
  startSupportSession: m.setImpersonationCookie,
  endSupportSession: vi.fn(),
  clearImpersonationCookie: vi.fn(),
  readImpersonationCookie: vi.fn().mockResolvedValue(null),
  readImpersonationCookieForStop: vi.fn().mockResolvedValue(null),
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
  purgeStartedAt: Date | null;
  suspendedPreviousStatus: string | null;
  suspensionBilling: unknown;
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
    purgeStartedAt: null,
    suspendedPreviousStatus: null,
    suspensionBilling: null,
    reviewLockedAt: null,
    stripeAccountId: null,
    timezone: "Europe/London",
    logoUrl: null,
    ...over,
  };
}

// A deliberately small evaluator for the tenant `where` clauses these routes
// use, so "the cron skips a suspended club" is tested against rows, not by
// string-matching the query. Conditional writes (updateMany / deleteMany) run
// against the same rows, so "the write only lands while X" is checked too.
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(row, w));
    const v = row[key];
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond !== "object") return v === cond;
    const c = cond as { in?: unknown[]; not?: unknown; lt?: Date; gte?: Date };
    if (c.in && !c.in.includes(v)) return false;
    if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
    if ("not" in c && c.not !== null && typeof c.not !== "object" && v === c.not) return false;
    if (c.lt && !(v instanceof Date && v.getTime() < c.lt.getTime())) return false;
    if (c.gte && !(v instanceof Date && v.getTime() >= c.gte.getTime())) return false;
    return true;
  });
}

function applyData(row: TenantRow, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    (row as Record<string, unknown>)[k] = v === Prisma.DbNull ? null : v;
  }
}

function installTenantTable() {
  type Args = { where?: Record<string, unknown>; data?: Record<string, unknown> };
  h.impl.tenant = {
    findMany: (args: unknown) =>
      tenants.filter((t) => matches(t, (args as Args)?.where)),
    findUnique: (args: unknown) => {
      const id = (args as { where: { id?: string } }).where.id;
      return tenants.find((t) => t.id === id) ?? null;
    },
    updateMany: (args: unknown) => {
      const { where, data } = args as Args;
      const hit = tenants.filter((t) => matches(t, where));
      for (const t of hit) applyData(t, data ?? {});
      return { count: hit.length };
    },
    deleteMany: (args: unknown) => {
      const before = tenants.length;
      tenants = tenants.filter((t) => !matches(t, (args as Args).where));
      return { count: before - tenants.length };
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
  m.requireStepUp.mockResolvedValue(GRANT);
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

    // The flip is conditional on the status that was read, and records it.
    const [statusFlip] = writes("tenant", "updateMany");
    const [userBump] = writes("user", "updateMany");
    const [memberBump] = writes("member", "updateMany");
    expect(statusFlip.args[0]).toMatchObject({
      where: { id: "t1", subscriptionStatus: "active" },
      data: { subscriptionStatus: "suspended", suspendedPreviousStatus: "active" },
    });
    expect(userBump.args[0]).toEqual({ where: { tenantId: "t1" }, data: { sessionVersion: { increment: 1 } } });
    expect(memberBump.args[0]).toEqual({ where: { tenantId: "t1" }, data: { sessionVersion: { increment: 1 } } });
    expect(new Set([statusFlip.tx, userBump.tx, memberBump.tx]).size).toBe(1);
    expect(tenants[0].subscriptionStatus).toBe("suspended");
  });

  // Was: "asks Stripe to stop renewing each member subscription (period end),
  // before the lock". Policy changed 6 Oct 2026 (SUSPENSION-BILLING-POLICY.md):
  // the club is the merchant, suspension is not the end of its service.
  it("leaves member billing alone and records the live subscriptions it left (policy, 6 Oct 2026)", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = {
      findMany: () => [{ stripeSubscriptionId: "sub_1" }, { stripeSubscriptionId: "sub_2" }],
    };
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(await res.json()).toMatchObject({
      ok: true,
      previousStatus: "active",
      memberBilling: "member-billing-unchanged",
      liveStripeSubscriptions: 2,
    });
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(tenants[0].suspensionBilling).toMatchObject({
      policy: "member-billing-unchanged",
      stripeSubscriptionIds: ["sub_1", "sub_2"],
    });
    expect(m.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.tenant.suspended",
        metadata: expect.objectContaining({ previousStatus: "active", stripeSubscriptionIds: ["sub_1", "sub_2"] }),
      }),
    );
  });

  // Was "CURRENT BEHAVIOUR (open finding): a Stripe failure does not stop the
  // suspension — billing may continue". Suspension makes no provider call any
  // more, so a degraded Stripe can neither block it nor half-apply it.
  it("FIXED (was open finding): a Stripe outage cannot half-apply a suspension — no provider call is made", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = { findMany: () => [{ stripeSubscriptionId: "sub_1" }] };
    m.cancelAtPeriodEnd.mockResolvedValue({ ok: false, status: 500, error: "stripe down" });
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(res.status).toBe(200);
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(writes("tenant", "updateMany")).toHaveLength(1);
  });

  it("a concurrent status change makes the suspension a 409, not a second write", async () => {
    tenants = [tenant({ id: "t1" })];
    // Between the read and the flip, something else moves the club on.
    h.impl.member = {
      findMany: () => {
        tenants[0].subscriptionStatus = "suspended";
        return [];
      },
    };
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(res.status).toBe(409);
    expect(writes("user", "updateMany")).toHaveLength(0);
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  // Was "CURRENT BEHAVIOUR (open finding): reactivation sets 'active' whatever
  // the club was, and never undoes the period-end cancellations".
  it("FIXED (was open finding): reactivation restores the recorded status — a trial club stays on trial", async () => {
    tenants = [
      tenant({
        id: "t1",
        subscriptionStatus: "suspended",
        stripeAccountId: "acct_1",
        suspendedPreviousStatus: "trial",
        suspensionBilling: { policy: "member-billing-unchanged", liveStripeSubscriptions: 0, stripeSubscriptionIds: [] },
      }),
    ];
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      restoredStatus: "trial",
      previousStatusSource: "recorded",
      billingReview: { required: false },
    });
    expect(tenants[0]).toMatchObject({ subscriptionStatus: "trial", suspendedPreviousStatus: null, suspensionBilling: null });
    // Un-suspension never touches a cancellation flag by itself.
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("reactivating a club suspended under the old code: status from the audit trail, cancellations listed for review, none cleared", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "suspended", stripeAccountId: "acct_1" })];
    h.impl.auditLog = {
      findFirst: () => ({
        metadata: { previousStatus: "trial", stripeCancelled: 2, stripeFailed: 1, stripeFailedIds: ["sub_3"] },
      }),
    };
    h.impl.member = {
      findMany: () => [{ stripeSubscriptionId: "sub_1" }, { stripeSubscriptionId: "sub_2" }, { stripeSubscriptionId: "sub_3" }],
    };
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      restoredStatus: "trial",
      previousStatusSource: "audit",
      billingReview: {
        required: true,
        stripeCancelledBySuspension: 2,
        stripeFailedIds: ["sub_3"],
        currentStripeSubscriptionIds: ["sub_1", "sub_2", "sub_3"],
      },
    });
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("a club suspended with no record at all comes back 'active', flagged as a default", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "suspended" })];
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(await res.json()).toMatchObject({ restoredStatus: "active", previousStatusSource: "default" });
  });

  it("un-suspending a club that is not suspended is a 409 and writes nothing (it used to flip trial to active)", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "trial" })];
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(409);
    expect(tenants[0].subscriptionStatus).toBe("trial");
    expect(writes("tenant", "updateMany")).toHaveLength(0);
  });

  it("TeamUp-billed members (no Stripe subscription) are invisible to suspension billing", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = { findMany: () => [] };
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(await res.json()).toMatchObject({ liveStripeSubscriptions: 0 });
    const memberRead = writes("member", "findMany")[0].args[0] as { where: Record<string, unknown> };
    expect(memberRead.where).toEqual({ tenantId: "t1", stripeSubscriptionId: { not: null } });
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("D4: un-suspend writes only against the suspension it read — a different suspension in between is a 409", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "suspended", suspendedPreviousStatus: "trial", suspensionBilling: { policy: "member-billing-unchanged" } })];
    // Between our read and our write: un-suspended, then suspended again from
    // "active". Same subscriptionStatus, different recorded previous status.
    const read = h.impl.tenant.findUnique;
    h.impl.tenant.findUnique = (args: unknown) => {
      const row = { ...(read(args) as TenantRow) };
      tenants[0].suspendedPreviousStatus = "active";
      return row;
    };
    const res = await suspendRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(409);
    expect(tenants[0]).toMatchObject({ subscriptionStatus: "suspended", suspendedPreviousStatus: "active" });
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it("the suspension and its audit row commit in one transaction; an audit failure is a 500 and nothing is reported as done", async () => {
    tenants = [tenant({ id: "t1", subscriptionStatus: "active" })];
    m.logAudit.mockImplementationOnce(async (a: { tx?: unknown }) => {
      expect(a.tx).toBeDefined();
      throw new Error("audit insert failed");
    });
    const res = await suspendRoute.POST(adminReq("POST", { reason: "Unpaid for three months" }), params("t1"));
    expect(res.status).toBe(500);
    // (In Postgres the transaction rolls back; the mock only proves the row is
    // written inside the same transaction as the flip.)
    const flip = writes("tenant", "updateMany")[0];
    const auditCallTx = h.calls.filter((c) => c.model === "user" && c.method === "updateMany")[0]?.tx;
    expect(flip.tx).toBe(auditCallTx);
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
    const [stamp] = writes("tenant", "updateMany");
    const [userBump] = writes("user", "updateMany");
    const [memberBump] = writes("member", "updateMany");
    // Conditional: a club already soft-deleted is never re-stamped (the purge clock is set once).
    expect(stamp.args[0]).toEqual({ where: { id: "t1", deletedAt: null }, data: { deletedAt: NOW } });
    expect(userBump.args[0]).toMatchObject({ data: { sessionVersion: { increment: 1 } } });
    expect(memberBump.args[0]).toMatchObject({ data: { sessionVersion: { increment: 1 } } });
    expect(new Set([stamp.tx, userBump.tx, memberBump.tx]).size).toBe(1);
  });

  // Was "CURRENT BEHAVIOUR (open finding): restore has no grace-window check
  // and an unconditional write". Privacy policy §6: recoverable for 30 days.
  it("FIXED (was open finding): restore past the 30-day window is refused with the real state and writes nothing", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "recovery-window-expired" });
    expect(tenants[0].deletedAt).not.toBeNull();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it("restore inside the window succeeds through one conditional write", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 29 * DAY_MS) })];
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(200);
    expect(tenants[0].deletedAt).toBeNull();
    const [restore] = writes("tenant", "updateMany");
    expect(restore.args[0]).toMatchObject({ where: { id: "t1", purgeStartedAt: null }, data: { deletedAt: null } });
  });

  it("restore at exactly 30 days is still allowed; one millisecond later it is not (boundary matches the purge)", async () => {
    tenants = [tenant({ id: "edge", deletedAt: new Date(NOW.getTime() - 30 * DAY_MS) })];
    expect((await softDeleteRoute.DELETE(adminReq("DELETE"), params("edge"))).status).toBe(200);
    tenants = [tenant({ id: "late", deletedAt: new Date(NOW.getTime() - 30 * DAY_MS - 1) })];
    expect((await softDeleteRoute.DELETE(adminReq("DELETE"), params("late"))).status).toBe(409);
  });

  it("restore after the purge has claimed the club is a 409 'deletion in progress', never 200", async () => {
    tenants = [
      tenant({
        id: "t1",
        deletedAt: new Date(NOW.getTime() - 20 * DAY_MS), // inside the window, but claimed
        purgeStartedAt: new Date(NOW.getTime() - 60_000),
      }),
    ];
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "deletion-in-progress" });
    expect(tenants[0].deletedAt).not.toBeNull();
  });

  it("restore after the purge finished says 'permanently deleted', not 'not found'", async () => {
    tenants = [];
    h.impl.auditLog = { findFirst: () => ({ id: "a1" }) };
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ state: "permanently-deleted" });
  });

  it("a second soft-delete racing the first is a 409, and the clock is not reset", async () => {
    const first = new Date(NOW.getTime() - 1000);
    tenants = [tenant({ id: "t1" })];
    // The other request stamps between this one's read and its write.
    h.impl.tenant.findUnique = (args: unknown) => {
      const a = args as { where: { id: string }; select?: Record<string, unknown> };
      const t = tenants.find((x) => x.id === a.where.id) ?? null;
      const snapshot = t ? { ...t, reviewSnapshotAt: null, reviewNote: null } : null;
      // Only the route's own read (the one that selects the Stripe account) is
      // followed by the competing stamp; the review-lock read is not.
      if (t && a.select?.stripeAccountId) t.deletedAt = first;
      return snapshot;
    };
    const res = await softDeleteRoute.POST(adminReq("POST", { reason: "Closing down", confirmName: "Club t1" }), params("t1"));
    expect(res.status).toBe(409);
    expect(tenants[0].deletedAt).toEqual(first);
    expect(writes("user", "updateMany")).toHaveLength(0);
  });

  it("soft-delete demands a step-up grant for this club: refused before anything is written or cancelled", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    m.requireStepUp.mockResolvedValueOnce(new Response(JSON.stringify({ stepUpRequired: true }), { status: 403 }));
    const res = await softDeleteRoute.POST(adminReq("POST", { reason: "Club closed for good", confirmName: "Club t1" }), params("t1"));
    expect(res.status).toBe(403);
    expect(m.requireStepUp).toHaveBeenCalledWith(expect.anything(), expect.anything(), "tenant.soft_delete", "t1", { change: {} });
    expect(tenants[0].deletedAt).toBeNull();
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it("soft-delete records the request durably BEFORE any Stripe call, and refuses everything if it cannot", async () => {
    tenants = [tenant({ id: "t1", stripeAccountId: "acct_1" })];
    h.impl.member = { findMany: () => [{ id: "m1", stripeSubscriptionId: "sub_1" }] };
    m.logAudit.mockRejectedValueOnce(new Error("audit insert failed"));
    const res = await softDeleteRoute.POST(adminReq("POST", { reason: "Club closed for good", confirmName: "Club t1" }), params("t1"));
    expect(res.status).toBe(500);
    // Lane C (9 Oct 2026): the request row is now written in the SAME
    // transaction as the grant's spend (logAudit({ tx })) — still durable
    // (awaited, throws) and still before any Stripe call. Was `durable: true`.
    expect(m.logAudit.mock.calls[0][0]).toMatchObject({ tx: expect.anything(), action: "admin.tenant.soft_delete.requested", outcome: "requested", requestId: "rq-test" });
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(tenants[0].deletedAt).toBeNull();
  });

  it("soft-delete writes the outcome row inside the stamp transaction; if it fails the club is not deleted (500, not success)", async () => {
    tenants = [tenant({ id: "t1" })];
    m.logAudit
      .mockResolvedValueOnce(undefined) // requested
      .mockImplementationOnce(async (a: { tx?: unknown; action: string }) => {
        expect(a.tx).toBeDefined();
        expect(a.action).toBe("admin.tenant.soft_deleted");
        throw new Error("audit insert failed");
      });
    const res = await softDeleteRoute.POST(adminReq("POST", { reason: "Club closed for good", confirmName: "Club t1" }), params("t1"));
    expect(res.status).toBe(500);
    const stamp = writes("tenant", "updateMany")[0];
    const bump = writes("user", "updateMany")[0];
    expect(stamp.tx).toBe(bump.tx);
  });

  it("restore returns a billing review when deletion stopped member renewals, and audits in the restore transaction", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 5 * DAY_MS), stripeAccountId: "acct_1" })];
    h.impl.auditLog = { findFirst: () => ({ metadata: { stripeCancelled: 2 } }) };
    h.impl.member = { findMany: () => [{ stripeSubscriptionId: "sub_1" }, { stripeSubscriptionId: "sub_2" }] };
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      billingReview: { required: true, stripeCancelledByDeletion: 2, stripeSubscriptionIds: ["sub_1", "sub_2"] },
    });
    expect(m.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "admin.tenant.restored", tx: expect.anything() }));
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
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
  const tenantHardDelete = async (res: { json: () => Promise<unknown> }) =>
    ((await res.json()) as { results: Array<Record<string, unknown>> }).results.find((r) => r.rule === "tenantHardDelete")!;

  // Was "CURRENT BEHAVIOUR (open finding): a restore that commits mid-purge
  // does not stop the purge — the tenant row is still deleted". A restore can
  // no longer commit once the purge has claimed the club (see the 409 tests
  // above); this models the one write that still could clear deletedAt — an
  // instance running the OLD restore code during a rollout — and checks the
  // next guarded step stops the purge instead of erasing a live club.
  it("FIXED (was open finding): deletedAt cleared mid-purge aborts the next step — the tenant row survives and the run is a 500", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    h.impl.member = {
      findMany: (args: unknown) => {
        const where = (args as { where: Record<string, unknown> }).where;
        if (where.parentMemberId) tenants[0].deletedAt = null;
        return [];
      },
    };
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(500);
    expect(tenants).toHaveLength(1);
    expect(tenants[0].deletedAt).toBeNull();
    expect(writes("tenant", "deleteMany")).toHaveLength(0);
    expect(writes("tenant", "delete")).toHaveLength(0);
  });

  it("a club restored before the purge reaches it is skipped untouched — no claim, no Stripe call, no delete", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), stripeAccountId: "acct_1" })];
    // The restore lands after the candidate query but before the preflight.
    const candidates = h.impl.tenant.findMany;
    h.impl.tenant.findMany = (args: unknown) => {
      const out = candidates(args) as TenantRow[];
      tenants[0].deletedAt = null;
      return out.map((t) => ({ ...t }));
    };
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(await tenantHardDelete(res)).toMatchObject({ deleted: 0, details: { skipped: [{ tenantId: "t1", reason: "restored" }] } });
    expect(tenants[0].purgeStartedAt).toBeNull();
    expect(m.cancelAtPeriodEnd).not.toHaveBeenCalled();
    expect(writes("task", "deleteMany")).toHaveLength(0);
  });

  it("every destructive transaction opens with the claim guard, and the final delete is conditional", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    h.impl.task = { findMany: () => [{ id: "task1" }] };
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(tenants).toHaveLength(0);

    const guardTxs = new Set(
      writes("tenant", "updateMany")
        .filter((c) => JSON.stringify((c.args[0] as { where: unknown }).where).includes("purgeStartedAt"))
        .map((c) => c.tx),
    );
    const destructive = h.calls.filter((c) => c.method === "deleteMany" && c.model !== "tenant");
    expect(destructive.length).toBeGreaterThan(0);
    for (const d of destructive) expect(guardTxs.has(d.tx)).toBe(true);

    const [finalDelete] = writes("tenant", "deleteMany");
    expect(finalDelete.args[0]).toMatchObject({ where: { id: "t1", deletedAt: { not: null }, purgeStartedAt: NOW } });
    // Evidence row in the same transaction as the delete.
    const [evidence] = writes("auditLog", "create");
    expect(evidence.tx).toBe(finalDelete.tx);
    expect(writes("tenant", "delete")).toHaveLength(0);
  });

  it("purge steps still run as separate transactions (each guarded), so a deadline-cut purge resumes", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    await retentionCron(cronReq("/api/cron/retention"));
    const taskTx = writes("task", "findMany")[0]?.tx;
    const tenantDeleteTx = writes("tenant", "deleteMany")[0]?.tx;
    expect(taskTx).toBeDefined();
    expect(tenantDeleteTx).toBeDefined();
    expect(taskTx).not.toBe(tenantDeleteTx);
  });

  it("an already-claimed club (crash or deadline last night) is resumed with its original claim", async () => {
    const claimedAt = new Date(NOW.getTime() - DAY_MS);
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), purgeStartedAt: claimedAt })];
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(await tenantHardDelete(res)).toMatchObject({ deleted: 1, details: { purged: [{ tenantId: "t1", resumed: true }] } });
    expect(writes("tenant", "deleteMany")[0].args[0]).toMatchObject({ where: { purgeStartedAt: claimedAt } });
  });

  it("a duplicate run after the purge finished finds nothing to do and reports success", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    expect((await retentionCron(cronReq("/api/cron/retention"))).status).toBe(200);
    h.reset();
    installTenantTable();
    const again = await retentionCron(cronReq("/api/cron/retention"));
    expect(again.status).toBe(200);
    expect(await tenantHardDelete(again)).toMatchObject({ deleted: 0, details: { candidates: 0 } });
  });

  it("retention boundary: exactly 30 days is not yet due; one millisecond past is", async () => {
    tenants = [
      tenant({ id: "edge", deletedAt: new Date(NOW.getTime() - 30 * DAY_MS) }),
      tenant({ id: "due", deletedAt: new Date(NOW.getTime() - 30 * DAY_MS - 1) }),
    ];
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(tenants.map((t) => t.id)).toEqual(["edge"]);
    expect(tenants[0].purgeStartedAt).toBeNull();
  });

  // Renamed (review of lane C, D1): was "...unclaimed and still restorable".
  // The club is past its 30-day window, so restore refuses it; what the
  // refusal guarantees is that nothing was deleted and nothing was claimed.
  it("a billing refusal leaves the club unclaimed and intact (past its window, so not restorable)", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), stripeAccountId: "acct_1" })];
    h.impl.member = {
      findMany: (args: unknown) =>
        JSON.stringify(args).includes("stripeSubscriptionId") ? [{ id: "m1", name: "A Member", stripeSubscriptionId: "sub_1" }] : [],
    };
    m.cancelAtPeriodEnd.mockResolvedValue({ ok: false, status: 500, error: "stripe down" });
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    expect(tenants[0].purgeStartedAt).toBeNull();
    expect(writes("task", "deleteMany")).toHaveLength(0);
    expect(await tenantHardDelete(res)).toMatchObject({
      details: { failures: [{ tenantId: "t1", reason: expect.stringContaining("stripe down"), cancelledBeforeBlock: 0 }] },
    });
    // And restore agrees it is past the window.
    const restore = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(restore.status).toBe(409);
    expect(await restore.json()).toMatchObject({ state: "recovery-window-expired" });
  });

  it("D1: subscriptions cancelled before the refusal are counted, not hidden", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), stripeAccountId: "acct_1" })];
    h.impl.member = {
      findMany: (args: unknown) =>
        JSON.stringify(args).includes("stripeSubscriptionId")
          ? [
              { id: "m1", name: "A Member", stripeSubscriptionId: "sub_1" },
              { id: "m2", name: "B Member", stripeSubscriptionId: "sub_2" },
            ]
          : [],
    };
    m.cancelAtPeriodEnd
      .mockResolvedValueOnce({ ok: true, cancelAt: null })
      .mockResolvedValueOnce({ ok: false, status: 500, error: "stripe down" });
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(await tenantHardDelete(res)).toMatchObject({
      details: { failures: [{ tenantId: "t1", cancelledBeforeBlock: 1, reason: expect.stringContaining("1 subscription(s) before it") }] },
    });
  });

  it("D2: the claimed/unclaimed split reads the claim inside the preflight, not the stale candidate list", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), stripeAccountId: "acct_1" })];
    // The candidate list is read before another run claims the club.
    const candidates = h.impl.tenant.findMany;
    h.impl.tenant.findMany = (args: unknown) => {
      const out = (candidates(args) as TenantRow[]).map((t) => ({ ...t }));
      tenants[0].purgeStartedAt = new Date(NOW.getTime() - 60_000);
      return out;
    };
    h.impl.member = {
      findMany: (args: unknown) =>
        JSON.stringify(args).includes("stripeSubscriptionId") ? [{ id: "m1", name: "A Member", stripeSubscriptionId: "sub_1" }] : [],
    };
    m.cancelAtPeriodEnd.mockResolvedValue({ ok: false, status: 500, error: "stripe down" });
    const res = await retentionCron(cronReq("/api/cron/retention"));
    // Claimed (possibly part-deleted) is an error, even though the stale list said unclaimed.
    expect(res.status).toBe(500);
    expect(await tenantHardDelete(res)).toMatchObject({
      details: { failures: [{ tenantId: "t1", error: expect.stringContaining("resumed purge blocked on billing") }] },
    });
  });

  it("D3: a purge step that times out waiting on the Tenant row is skipped as busy, not reported as a failure", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    h.impl.task = {
      findMany: () => {
        throw Object.assign(new Error("Transaction already closed: A commit cannot be executed on an expired transaction."), { code: "P2028" });
      },
    };
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(200);
    const rule = await tenantHardDelete(res);
    expect(rule).toMatchObject({ deleted: 0, details: { skipped: [{ tenantId: "t1", reason: "busy" }], failures: [] } });
    expect(rule.error).toBeUndefined();
    // The claim stands, so the next run resumes it.
    expect(tenants[0].purgeStartedAt).toEqual(NOW);
  });

  it("D3: a restore that times out waiting on the Tenant row answers 503 busy, and nothing changed", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 5 * DAY_MS) })];
    h.impl.tenant.updateMany = () => {
      throw Object.assign(new Error("Unable to start a transaction in the given time."), { code: "P2028" });
    };
    const res = await softDeleteRoute.DELETE(adminReq("DELETE"), params("t1"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ state: "busy" });
    expect(tenants[0].deletedAt).not.toBeNull();
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it("a billing refusal on an already-claimed (possibly part-deleted) club is an error, not a quiet skip", async () => {
    tenants = [
      tenant({
        id: "t1",
        deletedAt: new Date(NOW.getTime() - 40 * DAY_MS),
        purgeStartedAt: new Date(NOW.getTime() - DAY_MS),
        stripeAccountId: "acct_1",
      }),
    ];
    h.impl.member = {
      findMany: (args: unknown) =>
        JSON.stringify(args).includes("stripeSubscriptionId") ? [{ id: "m1", name: "A Member", stripeSubscriptionId: "sub_1" }] : [],
    };
    m.cancelAtPeriodEnd.mockResolvedValue({ ok: false, status: 500, error: "stripe down" });
    const res = await retentionCron(cronReq("/api/cron/retention"));
    expect(res.status).toBe(500);
    expect(await tenantHardDelete(res)).toMatchObject({ error: expect.stringContaining("t1") });
    expect(tenants).toHaveLength(1);
  });

  it("the cron refuses without the bearer (401) and without CRON_SECRET configured (503), before any work", async () => {
    tenants = [tenant({ id: "t1", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS) })];
    const noBearer = await retentionCron(new Request("https://matflow.studio/api/cron/retention"));
    expect(noBearer.status).toBe(401);
    const wrong = await retentionCron(
      new Request("https://matflow.studio/api/cron/retention", { headers: { authorization: "Bearer nope" } }),
    );
    expect(wrong.status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await retentionCron(cronReq("/api/cron/retention"))).status).toBe(503);
    expect(h.calls).toHaveLength(0);
    expect(tenants).toHaveLength(1);
  });
});

// ─── Impersonation ───────────────────────────────────────────────────────────

describe("impersonation into a closed club", () => {
  // Was "CURRENT BEHAVIOUR (open finding): an operator can start impersonating a user of a suspended or
  // deleted club" — it returned 200 and minted the cookie without ever reading the club's status (audit
  // 5 Oct 2026 Q8, Low-Medium). Since 6 Oct 2026 (lane B) the start reads the club and refuses one that
  // does not admit sign-in, BEFORE the step-up grant is spent; auth.ts re-checks it on every request.
  const owner = (sub: string, deletedAt: Date | null) => ({
    id: "u1", tenantId: "t1", email: "owner@example.test", name: "Owner", role: "owner", sessionVersion: 0,
    tenant: { subscriptionStatus: sub, deletedAt },
  });

  it.each([
    ["suspended", "suspended", null],
    ["deleted", "active", new Date()],
    ["cancelled", "cancelled", null],
  ] as const)("REFUSED: a %s club cannot be entered, and the operator's grant is not spent", async (_label, sub, deletedAt) => {
    h.impl.user = { findUnique: () => owner(sub, deletedAt) };
    m.requireStepUp.mockResolvedValue(GRANT);
    const res = await impersonateStart(adminReq("POST", { targetUserId: "u1", reason: "Support ticket 42" }));
    expect(res.status).toBe(409);
    expect(m.setImpersonationCookie).not.toHaveBeenCalled();
    expect(m.requireStepUp).not.toHaveBeenCalled();
  });

  it("positive control: an active club is entered once the step-up grant is accepted", async () => {
    h.impl.user = { findUnique: () => owner("active", null) };
    m.setImpersonationCookie.mockResolvedValue({ expiresAt: new Date(Date.now() + 1_800_000) });
    m.requireStepUp.mockResolvedValue(GRANT);
    const res = await impersonateStart(adminReq("POST", { targetUserId: "u1", reason: "Support ticket 42" }));
    expect(res.status).toBe(200);
    expect(m.requireStepUp).toHaveBeenCalledWith(expect.anything(), { operatorId: "op_1", named: true, sessionVersion: 4 }, "support.impersonate", "t1/u1", { change: {} });
    expect(m.setImpersonationCookie).toHaveBeenCalledWith(expect.objectContaining({
      operatorId: "op_1", operatorSessionVersion: 4, target: { id: "u1", tenantId: "t1", sessionVersion: 0 },
    }));
  });
});
