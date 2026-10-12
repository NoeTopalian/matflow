/**
 * DSAR erase: the "refuse if the audit write fails" guard is reachable
 * (operator audit 5 Oct 2026, Q9-1; lane D, 6 Oct 2026).
 *
 * The REAL lib/audit-log.ts runs here; only the database client is a mock. An
 * injected insert failure must leave the member untouched: no Stripe call when
 * the request row fails, and no scrub or delete of any kind when the
 * fulfilment row (the first statement of the erase transaction) fails.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<{ tx: number; model: string; method: string; args: unknown[] }> = [];
  const impl: Record<string, Record<string, (...a: unknown[]) => unknown>> = {};
  const DEFAULTS: Record<string, () => unknown> = {
    findMany: () => [],
    findFirst: () => null,
    findUnique: () => null,
    count: () => 0,
    deleteMany: () => ({ count: 0 }),
    updateMany: () => ({ count: 0 }),
    update: () => ({}),
    create: () => ({}),
  };
  let nextTx = 0;
  function makeTx(tx: number) {
    return new Proxy({} as Record<string, unknown>, {
      get(_t, model: string) {
        if (model === "$executeRaw") return async () => 0;
        // The erase re-reads the member under a row lock (lane D3): answer with the member row this fake holds.
        if (model === "$queryRaw") return async () => { const m = impl.member?.findFirst?.(); return m ? [m] : []; };
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
    openTx: () => makeTx(++nextTx),
    reset() {
      calls.length = 0;
      for (const k of Object.keys(impl)) delete impl[k];
      nextTx = 0;
    },
    cancel: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(h.openTx()),
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(h.openTx()),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiRole: async () => ({ ok: true, session: { user: { id: "u-owner", tenantId: "t-club", role: "owner" } } }),
  refuseSupportSession: () => null,
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: async () => null }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: h.cancel }));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));

import { POST } from "@/app/api/admin/dsar/erase/route";

const erase = () =>
  POST(new Request("http://localhost/api/admin/dsar/erase?memberId=m1", { method: "POST" }));

const DESTRUCTIVE = new Set(["update", "updateMany", "delete", "deleteMany"]);
const destructiveCalls = () => h.calls.filter((c) => DESTRUCTIVE.has(c.method));
const auditCreates = () => h.calls.filter((c) => c.model === "auditLog" && c.method === "create");

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.impl.member = {
    findFirst: () => ({
      id: "m1",
      status: "active",
      email: "alice@example.test",
      name: "Alice",
      stripeSubscriptionId: "sub_1",
      externalRef: null,
    }),
  };
  h.impl.tenant = { findUnique: () => ({ stripeAccountId: "acct_1" }) };
  h.impl.user = { findFirst: () => ({ id: "u-owner" }) };
  h.cancel.mockResolvedValue({ ok: true, cancelAt: 1_800_000_000 });
});

describe("DSAR erase — durable audit", () => {
  it("control: with the audit store healthy the erase runs, and the fulfilment row is the first write of the erase transaction", async () => {
    const res = await erase();
    expect(res.status).toBe(200);
    const [requested, fulfilment] = auditCreates();
    expect((requested.args[0] as { data: { action: string } }).data.action).toBe("member.dsar_erase.requested");
    expect((fulfilment.args[0] as { data: { action: string } }).data.action).toBe("member.dsar_erase");
    const memberUpdate = h.calls.find((c) => c.model === "member" && c.method === "update")!;
    expect(memberUpdate.tx).toBe(fulfilment.tx);
    const firstWriteInTx = h.calls.find((c) => c.tx === fulfilment.tx && (DESTRUCTIVE.has(c.method) || c.method === "create"));
    expect(firstWriteInTx).toBe(fulfilment);
    expect(requested.tx).not.toBe(fulfilment.tx);
  });

  it("INJECTED FAILURE (request row): nothing is cancelled at Stripe and nothing is erased", async () => {
    h.impl.auditLog = {
      create: () => {
        throw new Error("audit store down");
      },
    };
    const res = await erase();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/erasure not performed/);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(destructiveCalls()).toHaveLength(0);
  });

  it("INJECTED FAILURE (fulfilment row): the erase transaction stops at its first statement — nothing is scrubbed or deleted", async () => {
    h.impl.auditLog = {
      create: (args: unknown) => {
        if ((args as { data: { action: string } }).data.action === "member.dsar_erase") throw new Error("audit store down");
        return {};
      },
    };
    const res = await erase();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/nothing was erased/);
    // Honest about the one side effect that did happen.
    expect(body.error).toMatch(/Stripe subscription is already set to stop renewing/);
    expect(destructiveCalls()).toHaveLength(0);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("the fulfilment record carries no email address, only its HMAC", async () => {
    await erase();
    const text = JSON.stringify(auditCreates().map((c) => c.args[0]));
    expect(text).not.toContain("alice@example.test");
    expect(text).toContain("originalEmailHash");
  });
});
