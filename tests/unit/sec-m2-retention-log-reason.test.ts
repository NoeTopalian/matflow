/**
 * SF-128 (review R8 residual) — the retention cron's one-line call log names WHY it answered (security campaign
 * iteration 2, lane M2, 10 Oct 2026; authorised by Noe 10 Oct 23:29 Italy).
 *
 * Lane M1 v2 added `[cron/retention] call gate=… dryRun=… status=…`. R8 found that the gate-off refusal and the
 * missing-CRON_SECRET refusal both read `status=503`, so an operator reading the logs could not tell "the job is
 * switched off" from "the job is broken". Each call line now carries a `reason=` token from a closed set, and still
 * never the payload, the bearer or any count.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@vercel/blob", () => ({ del: vi.fn().mockResolvedValue(undefined) }));

const m = vi.hoisted(() => ({ reconcile: vi.fn(), purge: vi.fn() }));
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
  const model = () => ({ findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() });
  return {
    prisma: {
      auditLog: model(), emailLog: model(), loginEvent: model(), magicLinkToken: model(), passwordResetToken: model(),
      rateLimitHit: model(), stripeEvent: model(), importUpload: model(), importJob: model(),
    },
  };
});

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/cron/retention/route";

const SECRET = "secm2-cron-secret-not-real";
type Delegate = Record<"findMany" | "deleteMany" | "updateMany" | "count", ReturnType<typeof vi.fn>>;
const delegates = () => Object.values(prisma as unknown as Record<string, Delegate>);
let lines: string[] = [];
const callLines = () => lines.filter((l) => l.startsWith("[cron/retention] call "));

function req(query = "", auth: string | null = `Bearer ${SECRET}`) {
  return new Request(`https://matflow.test/api/cron/retention${query}`, auth ? { headers: { authorization: auth } } : {});
}

/** Calls GET once and returns its status and its single call line. */
async function call(query = "", auth: string | null = `Bearer ${SECRET}`) {
  const before = callLines().length;
  const res = await GET(req(query, auth));
  const after = callLines();
  expect(after.length - before, "exactly one call line per request").toBe(1);
  return { status: res.status, line: after[after.length - 1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  process.env.CRON_SECRET = SECRET;
  delete process.env.RETENTION_CRON_ENABLED;
  for (const d of delegates()) {
    d.findMany.mockResolvedValue([{ id: "secm2-row", tenantId: "secm2-t", fileBlobUrl: null }]);
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

describe("SF-128: the retention call line distinguishes 'disabled' from 'not configured'", () => {
  it("gate off + real bearer → 503 with reason=disabled", async () => {
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.line).toMatch(/ status=503 reason=disabled$/);
  });

  it("CRON_SECRET unset → 503 with reason=not_configured (the same status, a different reason)", async () => {
    delete process.env.CRON_SECRET;
    const r = await call();
    expect(r.status).toBe(503);
    expect(r.line).toMatch(/ status=503 reason=not_configured$/);
  });

  it("the two 503 lines are not identical (the residual R8 named)", async () => {
    const off = await call();
    delete process.env.CRON_SECRET;
    const unconfigured = await call();
    expect(off.line).not.toBe(unconfigured.line);
  });

  it("every other outcome names itself: unauthorized, dry_run (gate off and on), swept", async () => {
    expect((await call("", null)).line).toMatch(/ status=401 reason=unauthorized$/);
    expect((await call("", "Bearer wrong")).line).toMatch(/ status=401 reason=unauthorized$/);
    expect((await call("?dryRun=1")).line).toMatch(/gate=off dryRun=1 status=200 reason=dry_run$/);
    process.env.RETENTION_CRON_ENABLED = "true";
    expect((await call("?dryRun=1")).line).toMatch(/gate=on dryRun=1 status=200 reason=dry_run$/);
    expect((await call()).line).toMatch(/gate=on dryRun=0 status=200 reason=swept$/);
  });

  it("the line still carries no payload, no bearer and no count", async () => {
    await call();
    await call("?dryRun=1");
    delete process.env.CRON_SECRET;
    await call();
    for (const l of callLines()) {
      expect(l).toMatch(/^\[cron\/retention\] call gate=(on|off) dryRun=[01] status=\d{3} reason=[a-z_]+$/);
      expect(l).not.toContain(SECRET);
      expect(l).not.toMatch(/wouldDelete|results|secm2-|reconcile|\{|7/);
    }
  });
});
