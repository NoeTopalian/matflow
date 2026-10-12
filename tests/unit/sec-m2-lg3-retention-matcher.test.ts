/**
 * SF-128 — the e2e spec lg-3-machines-and-sweep makes the retention gate explicit (security campaign iteration 2,
 * lane M2, 10 Oct 2026; authorised by Noe 10 Oct 23:29 Italy).
 *
 * Before: lg-3's cron cell expected retention to answer 200, or a 503 whose error matched /not configured/. With the
 * M1 v2 gate off (the default, and now the local .env.test state) the route answers 503 `retention cron disabled`,
 * which that check rejects; the spec passed only where something had opened the gate — the e2e job env, or an
 * uncommitted RETENTION_CRON_ENABLED=true line in the shared .env.test that also opened the live sweep for any local
 * server on the shared TEST branch.
 *
 * After: the spec reads the gate state from the env the server shares with it, expects the NAMED gate-off answer
 * when it is off (and a live 200 only when it is on — the e2e job's ephemeral database), and a separate cell proves
 * the dry run still counts and deletes nothing. The e2e spec itself is NOT run locally (it would need CRON_SECRET in
 * a server's env and runs class-instances against the shared TEST branch); its expectation logic lives in
 * tests/e2e/campaign/assess/lg-3-retention-gate.ts and is proved here against the REAL route handler's answers.
 */
import fs from "node:fs";
import path from "node:path";
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
import {
  retentionGateOn,
  retentionBearerVerdict,
  retentionDryRunVerdict,
  RETENTION_DISABLED_ERROR,
} from "../e2e/campaign/assess/lg-3-retention-gate";

const SECRET = "secm2-cron-secret-not-real";
const SPEC = path.join(process.cwd(), "tests/e2e/campaign/assess/lg-3-machines-and-sweep.spec.ts");
type Delegate = Record<"findMany" | "deleteMany" | "updateMany" | "count", ReturnType<typeof vi.fn>>;
const delegates = () => Object.values(prisma as unknown as Record<string, Delegate>);

async function answer(query = "") {
  const res = await GET(new Request(`https://matflow.test/api/cron/retention${query}`, { headers: { authorization: `Bearer ${SECRET}` } }));
  return { status: res.status, body: (await res.json()) as unknown };
}

/** lg-3's retention expectation at HEAD fcd5454 (spec lines 165-170), reproduced to show why it was wrong. */
function headExpectation(a: { status: number; body: unknown }): boolean {
  if (![200, 503].includes(a.status)) return false;
  if (a.status === 503) return /not configured/i.test((a.body as { error?: string }).error ?? "");
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
  delete process.env.RETENTION_CRON_ENABLED;
  for (const d of delegates()) {
    d.findMany.mockResolvedValue([{ id: "secm2-row", tenantId: "secm2-t", fileBlobUrl: null }]);
    d.deleteMany.mockResolvedValue({ count: 1 });
    d.updateMany.mockResolvedValue({ count: 1 });
    d.count.mockResolvedValue(7);
  }
  m.reconcile.mockResolvedValue({ ok: true });
  m.purge.mockImplementation(async (_now: Date, _stop: () => boolean, dryRun: boolean) =>
    dryRun ? { deleted: 0, details: { candidates: 2, wouldPurge: [] } } : { deleted: 0 },
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RETENTION_CRON_ENABLED;
});

describe("SF-128: lg-3's retention expectation, proved against the real route", () => {
  it("the gate state is read exactly as the route reads it (only the string \"true\" opens it)", () => {
    expect(retentionGateOn({ RETENTION_CRON_ENABLED: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", " true", "true "]) {
      expect(retentionGateOn({ RETENTION_CRON_ENABLED: v }), String(v)).toBe(false);
    }
  });

  it("the bug: HEAD's expectation rejects the route's real gate-off answer", async () => {
    const a = await answer();
    expect(a).toEqual({ status: 503, body: { error: RETENTION_DISABLED_ERROR } });
    expect(headExpectation(a)).toBe(false);
  });

  it("gate off: the named 503 is the expected answer; a live sweep, a 500 or the not-configured 503 is not", async () => {
    expect(retentionBearerVerdict(await answer(), false)).toBeNull();
    process.env.RETENTION_CRON_ENABLED = "true";
    expect(retentionBearerVerdict(await answer(), false), "a live sweep with the gate believed off").toMatch(/gate/);
    expect(retentionBearerVerdict({ status: 503, body: { error: "CRON_SECRET not configured" } }, false)).not.toBeNull();
    expect(retentionBearerVerdict({ status: 500, body: { ok: false } }, false)).not.toBeNull();
    expect(retentionBearerVerdict({ status: 503, body: { error: "retention cron disabled " } }, false)).not.toBeNull();
  });

  it("gate on: only a live 200 sweep is expected; the disabled 503 means the server's gate disagrees", async () => {
    process.env.RETENTION_CRON_ENABLED = "true";
    expect(retentionBearerVerdict(await answer(), true)).toBeNull();
    delete process.env.RETENTION_CRON_ENABLED;
    expect(retentionBearerVerdict(await answer(), true)).toMatch(/gate/);
    expect(retentionBearerVerdict({ status: 500, body: { ok: false, dryRun: false } }, true)).not.toBeNull();
  });

  it("dry run, gate off and gate on: 200, counts present, nothing deleted, the gate reported truthfully", async () => {
    const off = await answer("?dryRun=1");
    expect(retentionDryRunVerdict(off, false)).toBeNull();
    expect(retentionDryRunVerdict(off, true), "gate reported off while the spec believes on").not.toBeNull();
    process.env.RETENTION_CRON_ENABLED = "true";
    const on = await answer("?dryRun=1");
    expect(retentionDryRunVerdict(on, true)).toBeNull();
    // Writes: none in either dry run (the mocks count every deleteMany/updateMany).
    expect(delegates().reduce((n, d) => n + d.deleteMany.mock.calls.length + d.updateMany.mock.calls.length, 0)).toBe(0);
  });

  it("dry-run controls: a deletion, missing counts, a live body or a non-200 is rejected", async () => {
    const good = (await answer("?dryRun=1")) as { status: number; body: { results: Array<Record<string, unknown>> } };
    const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
    const deleted = clone();
    deleted.body.results[1].deleted = 1;
    expect(retentionDryRunVerdict(deleted, false)).toMatch(/deleted/);
    const noCounts = clone();
    for (const r of noCounts.body.results) delete r.details;
    expect(retentionDryRunVerdict(noCounts, false)).toMatch(/count/);
    const live = clone();
    (live.body as unknown as { dryRun: boolean }).dryRun = false;
    expect(retentionDryRunVerdict(live, false)).toMatch(/dryRun/);
    expect(retentionDryRunVerdict({ status: 503, body: { error: RETENTION_DISABLED_ERROR } }, false)).not.toBeNull();
  });

  it("static: the spec uses these verdicts for retention, has a dry-run cell, and never sets the gate itself", () => {
    const src = fs.readFileSync(SPEC, "utf8");
    expect(src).toMatch(/from "\.\/lg-3-retention-gate"/);
    expect(src).toMatch(/retentionBearerVerdict\(/);
    expect(src).toMatch(/retentionDryRunVerdict\(/);
    expect(src).toMatch(/\/api\/cron\/retention\?dryRun=1/);
    // The named-dependency loop no longer includes retention (its 503 is a gate, not a missing service).
    expect(src).not.toMatch(/for \(const name of \["retention", "monthly-reports", "stripe-reconcile"\]/);
    // The spec never writes the gate into any environment.
    expect(src).not.toMatch(/RETENTION_CRON_ENABLED\s*=/);
    expect(src).not.toMatch(/process\.env\.RETENTION_CRON_ENABLED\s*=[^=]/);
  });

  it("static: the shared local .env.test carries no retention gate line (skipped where the file is absent, as in CI)", () => {
    const f = path.join(process.cwd(), ".env.test");
    if (!fs.existsSync(f)) return;
    const hasGate = fs.readFileSync(f, "utf8").split(/\r?\n/).some((l) => /^\s*(export\s+)?RETENTION_CRON_ENABLED\s*=/.test(l));
    expect(hasGate, ".env.test must not open the live sweep for every local server on the shared TEST branch").toBe(false);
  });
});
