/**
 * RETENTION_CRON_ENABLED, default OFF (security campaign iteration 2, lane M1 v2, 10 Oct 2026; authorised by Noe
 * 10 Oct 22:13 Italy: "Approve implementing and testing RETENTION_CRON_ENABLED, default OFF").
 *
 * The nightly retention sweep is a one-way door (a year of logs, 90 days of Stripe events, any club past its
 * soft-delete grace). Until a human has read a dry run and turned the job on, a scheduler call that carries the real
 * bearer must do NOTHING: 503 `{ error: "retention cron disabled" }` before any work — no reconcile, no count, no
 * delete. `?dryRun=1` stays allowed with the gate off (counts only, zero deletes) and the response says so. The gate
 * opens only on the exact string "true". One log line per call, no payload.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn().mockResolvedValue(undefined) }));

const m = vi.hoisted(() => ({
  reconcile: vi.fn(),
  purge: vi.fn(),
}));
vi.mock("@/lib/stripe/reconcile", () => ({ runStripeReconciliation: m.reconcile }));
vi.mock("@/lib/tenant-purge", () => ({ purgeSoftDeletedTenants: m.purge }));
vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
    withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
  };
});
vi.mock("@/lib/prisma", () => {
  const model = () => ({
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  });
  return {
    prisma: {
      auditLog: model(),
      emailLog: model(),
      loginEvent: model(),
      magicLinkToken: model(),
      passwordResetToken: model(),
      rateLimitHit: model(),
      stripeEvent: model(),
      importUpload: model(),
      importJob: model(),
    },
  };
});

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/cron/retention/route";

const SECRET = "secm1-cron-secret-not-real";
type Delegate = Record<"findMany" | "deleteMany" | "updateMany" | "count", ReturnType<typeof vi.fn>>;
const delegates = () => Object.values(prisma as unknown as Record<string, Delegate>);

let lines: string[] = [];

function req(query = "", auth: string | null = `Bearer ${SECRET}`) {
  return new Request(`https://matflow.test/api/cron/retention${query}`, auth ? { headers: { authorization: auth } } : {});
}

function writes() {
  return delegates().reduce((n, d) => n + d.deleteMany.mock.calls.length + d.updateMany.mock.calls.length, 0);
}
function reads() {
  return delegates().reduce((n, d) => n + d.findMany.mock.calls.length + d.count.mock.calls.length, 0);
}
const callLines = () => lines.filter((l) => l.startsWith("[cron/retention] call "));

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  process.env.CRON_SECRET = SECRET;
  delete process.env.RETENTION_CRON_ENABLED;
  for (const d of delegates()) {
    // Every model reports one row due, so a live sweep would delete something on every rule.
    d.findMany.mockResolvedValue([{ id: "secm1-row", tenantId: "secm1-t", fileBlobUrl: null }]);
    d.deleteMany.mockResolvedValue({ count: 1 });
    d.updateMany.mockResolvedValue({ count: 1 });
    d.count.mockResolvedValue(7);
  }
  m.reconcile.mockResolvedValue({ ok: true });
  m.purge.mockResolvedValue({ deleted: 0 });
  for (const k of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RETENTION_CRON_ENABLED;
});

describe("RETENTION_CRON_ENABLED gate (default OFF)", () => {
  it("gate unset + the real bearer → 503 'retention cron disabled' before any work: zero deletes, zero reads, no reconcile, no purge", async () => {
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "retention cron disabled" });
    expect(writes()).toBe(0);
    expect(reads()).toBe(0);
    expect(m.reconcile).not.toHaveBeenCalled();
    expect(m.purge).not.toHaveBeenCalled();
  });

  for (const v of ["", "false", "TRUE", "True", "1", "yes", " true", "true "]) {
    it(`gate ${JSON.stringify(v)} is not exactly "true" → 503, zero deletes`, async () => {
      process.env.RETENTION_CRON_ENABLED = v;
      const res = await GET(req());
      expect(res.status).toBe(503);
      expect(writes()).toBe(0);
      expect(m.purge).not.toHaveBeenCalled();
    });
  }

  it("gate off + ?dryRun=1 → counts, zero deletes, and the response says the gate is off", async () => {
    const res = await GET(req("?dryRun=1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun: boolean;
      retentionEnabled: boolean;
      note?: string;
      results: Array<{ rule: string; deleted?: number; details?: Record<string, unknown> }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.retentionEnabled).toBe(false);
    expect(body.note).toMatch(/retention cron disabled/i);
    expect(body.note).toMatch(/dry run/i);
    expect(writes()).toBe(0);
    expect(reads()).toBeGreaterThan(0);
    expect(body.results.every((r) => r.deleted === 0)).toBe(true);
    expect(body.results.find((r) => r.rule === "emailLog")?.details).toEqual({ wouldDelete: 7 });
    expect(m.purge).toHaveBeenCalledTimes(1);
    expect(m.purge.mock.calls[0][2]).toBe(true);
  });

  it('gate exactly "true" → unchanged behaviour: the sweep deletes and the purge runs live', async () => {
    process.env.RETENTION_CRON_ENABLED = "true";
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dryRun: boolean; results: Array<{ rule: string; deleted?: number }> };
    expect(body.dryRun).toBe(false);
    expect(prisma.emailLog.deleteMany).toHaveBeenCalled();
    expect(body.results.find((r) => r.rule === "emailLog")?.deleted).toBe(1);
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    expect(m.purge).toHaveBeenCalledTimes(1);
    expect(m.purge.mock.calls[0][2]).toBe(false);
  });

  it('gate "true" + ?dryRun=1 → still a dry run (zero deletes)', async () => {
    process.env.RETENTION_CRON_ENABLED = "true";
    const res = await GET(req("?dryRun=1"));
    expect(res.status).toBe(200);
    expect(writes()).toBe(0);
  });

  it("the door is unchanged with the gate off: no bearer → 401, CRON_SECRET unset → 503 'CRON_SECRET not configured'", async () => {
    expect((await GET(req("", null))).status).toBe(401);
    expect((await GET(req("?dryRun=1", "Bearer wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "CRON_SECRET not configured" });
    expect(writes() + reads()).toBe(0);
  });

  it("one log line per call, carrying the gate, the mode and the status — never the payload", async () => {
    await GET(req());
    await GET(req("?dryRun=1"));
    await GET(req("", null));
    process.env.RETENTION_CRON_ENABLED = "true";
    await GET(req());
    const calls = callLines();
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatch(/gate=off dryRun=0 status=503/);
    expect(calls[1]).toMatch(/gate=off dryRun=1 status=200/);
    expect(calls[2]).toMatch(/status=401/);
    expect(calls[3]).toMatch(/gate=on dryRun=0 status=200/);
    for (const l of calls) {
      expect(l).not.toMatch(/wouldDelete|results|secm1-|reconcile|\{/);
      expect(l).not.toContain(SECRET);
    }
  });
});
