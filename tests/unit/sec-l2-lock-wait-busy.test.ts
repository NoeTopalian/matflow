/**
 * R10-5 (lane L2 phase 2, 12 Oct 2026) — a tenant transaction that waits on a row lock must fail as "lock timeout"
 * (55P03), so isTenantRowBusyError (lib/tenant-lifecycle.ts) can answer "busy, try again". Before: lock_timeout was
 * EQUAL to statement_timeout (15 s / 15 s, 60 s / 60 s), so a statement waiting on a lock was cancelled by the
 * statement bound first (57014, "canceling statement due to statement timeout"); a club restore blocked by a purge step
 * answered 500 "could not be recorded" instead of the 503 busy, and the purge cron counted a failure instead of a
 * skip (review R10 phase 2, B4c, both roles).
 *
 * Choice: lock_timeout BELOW statement_timeout (10 s / 15 s; 45 s / 60 s) rather than treating 57014 as busy — a
 * statement timeout also means "this query is too slow", which is not "busy", so reading every 57014 as busy would make
 * isTenantRowBusyError lie about slow queries. A statement that waits on a lock now fails as 55P03 unless it spent more
 * than the 5 s / 15 s gap doing other work first, in which case it is (honestly) a statement timeout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sql: [] as string[],
  bypassCalls: 0,
  stepError: null as null | unknown,
  candidates: [] as Array<{ id: string; name: string; deletedAt: Date; purgeStartedAt: Date | null }>,
  realPrismaTenant: true,
}));

/** The error shapes Postgres + Prisma 7.4.2 + adapter-pg produce (recorded by tests/integration/sec-l2-tenant-bounds-db, both roles: code P2010, the SQLSTATE only in the message). */
const LOCK_WAIT = () =>
  Object.assign(new Error("Raw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`"), { name: "PrismaClientKnownRequestError", code: "P2010" });
const STATEMENT_TIMEOUT = () =>
  Object.assign(new Error("Raw query failed. Code: `57014`. Message: `canceling statement due to statement timeout`"), { name: "PrismaClientKnownRequestError", code: "P2010" });

vi.mock("@/lib/prisma", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma")>();
  return {
    ...real,
    prisma: {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          $executeRaw: async (s: unknown) => { h.sql.push((s as string[]).join("?")); return 1; },
          $queryRaw: async (s: unknown) => { h.sql.push((s as string[]).join("?")); return [{ pid: "1", ts: "1" }]; },
        }),
    },
  };
});

// The route and the cron get a withRlsBypass that fails like the real one does when the Tenant row is locked.
vi.mock("@/lib/prisma-tenant", async (orig) => {
  const real = await orig<typeof import("@/lib/prisma-tenant")>();
  const fake = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    h.bypassCalls++;
    if (h.bypassCalls === 1 && h.candidates.length) {
      return fn({ tenant: { findMany: async () => h.candidates } });
    }
    if (h.stepError) throw h.stepError;
    throw new Error("unexpected transaction in this test");
  };
  return {
    ...real,
    withRlsBypass: (fn: never, o?: never) => (h.realPrismaTenant ? real.withRlsBypass(fn, o) : fake(fn)),
    withTenantContext: (t: string, fn: never, o?: never) => (h.realPrismaTenant ? real.withTenantContext(t, fn, o) : fake(fn)),
  };
});

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers(init?.headers) }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ authed: true, named: true, operatorId: "op_1", operatorEmail: "operator@example.test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: vi.fn() }));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined) }));

import {
  withTenantContext,
  withRlsBypass,
  TENANT_STATEMENT_BOUND_MS,
  TENANT_STATEMENT_BOUND_EXTENDED_MS,
  TENANT_LOCK_BOUND_MS,
  TENANT_LOCK_BOUND_EXTENDED_MS,
} from "@/lib/prisma-tenant";
import { isTenantRowBusyError } from "@/lib/tenant-lifecycle";
import { DELETE as restoreClub } from "@/app/api/admin/customers/[id]/soft-delete/route";
import { purgeSoftDeletedTenants } from "@/lib/tenant-purge";

beforeEach(() => {
  h.sql = [];
  h.bypassCalls = 0;
  h.stepError = null;
  h.candidates = [];
  h.realPrismaTenant = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("R10-5: a lock wait in a tenant transaction ends as a lock timeout, below the statement bound", () => {
  it("the bounds: lock_timeout is strictly below statement_timeout, default and extended", () => {
    expect(TENANT_LOCK_BOUND_MS).toBeLessThan(TENANT_STATEMENT_BOUND_MS);
    expect(TENANT_LOCK_BOUND_EXTENDED_MS).toBeLessThan(TENANT_STATEMENT_BOUND_EXTENDED_MS);
    // the gap is the work a statement may do before it waits on a lock and still be reported as a lock wait
    expect(TENANT_STATEMENT_BOUND_MS - TENANT_LOCK_BOUND_MS).toBeGreaterThanOrEqual(5_000);
  });

  for (const [name, run] of [
    ["withTenantContext", (o?: { timeout?: number }) => withTenantContext("tenant-L2", async () => 1, o)],
    ["withRlsBypass", (o?: { timeout?: number }) => withRlsBypass(async () => 1, o)],
  ] as const) {
    it(`${name}: the first statement sets lock_timeout ${TENANT_LOCK_BOUND_MS} ms < statement_timeout ${TENANT_STATEMENT_BOUND_MS} ms (default budget)`, async () => {
      await run();
      expect(h.sql[0]).toContain(`set_config('lock_timeout', '${TENANT_LOCK_BOUND_MS}ms', true)`);
      expect(h.sql[0]).toContain(`set_config('statement_timeout', '${TENANT_STATEMENT_BOUND_MS}ms', true)`);
    });
    it(`${name}: extended budget → lock_timeout ${TENANT_LOCK_BOUND_EXTENDED_MS} ms < statement_timeout ${TENANT_STATEMENT_BOUND_EXTENDED_MS} ms`, async () => {
      await run({ timeout: 45_000 });
      expect(h.sql[0]).toContain(`set_config('lock_timeout', '${TENANT_LOCK_BOUND_EXTENDED_MS}ms', true)`);
      expect(h.sql[0]).toContain(`set_config('statement_timeout', '${TENANT_STATEMENT_BOUND_EXTENDED_MS}ms', true)`);
    });
  }

  it("isTenantRowBusyError stays honest: a lock wait (55P03) is busy; a statement timeout (57014) is not", () => {
    expect(isTenantRowBusyError(LOCK_WAIT())).toBe(true);
    expect(isTenantRowBusyError(STATEMENT_TIMEOUT())).toBe(false);
  });
});

describe("R10-5: the two callers answer a lock wait as busy", () => {
  const req = () => new Request("https://test.local/api/admin/customers/t1/soft-delete", { method: "DELETE", headers: { origin: "https://test.local", host: "test.local" } });

  it("restore blocked by a purge step (lock wait) → 503 busy with Retry-After, nothing changed", async () => {
    h.realPrismaTenant = false;
    h.stepError = LOCK_WAIT();
    const res = await restoreClub(req(), { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ state: "busy" });
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("restore that hits a statement timeout (a slow query, not a lock) → 500, honestly not 'busy'", async () => {
    h.realPrismaTenant = false;
    h.stepError = STATEMENT_TIMEOUT();
    const res = await restoreClub(req(), { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(500);
  });

  it("purge cron: a step blocked on the Tenant row (lock wait) is skipped as busy, not counted as a failure", async () => {
    h.realPrismaTenant = false;
    const now = new Date("2026-10-12T03:30:00.000Z");
    h.candidates = [{ id: "t1", name: "Club t1", deletedAt: new Date(now.getTime() - 40 * 86_400_000), purgeStartedAt: null }];
    h.stepError = LOCK_WAIT();
    const r = await purgeSoftDeletedTenants(now, () => false);
    expect(r.deleted).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.details).toMatchObject({ skipped: [{ tenantId: "t1", reason: "busy" }], failures: [] });
  });

  it("purge cron: a statement timeout in a step is a failure (not a quiet skip)", async () => {
    h.realPrismaTenant = false;
    const now = new Date("2026-10-12T03:30:00.000Z");
    h.candidates = [{ id: "t1", name: "Club t1", deletedAt: new Date(now.getTime() - 40 * 86_400_000), purgeStartedAt: null }];
    h.stepError = STATEMENT_TIMEOUT();
    const r = await purgeSoftDeletedTenants(now, () => false);
    expect(r.details).toMatchObject({ skipped: [], failures: [{ tenantId: "t1" }] });
  });
});
