/**
 * Are the crons alive?
 *
 * `vercel.json` schedules three jobs (monthly-reports, retention,
 * class-instances) and a fourth route (stripe-reconcile) exists for ad-hoc
 * runs. Nothing in the repo had ever CALLED any of their `GET` handlers —
 * every existing test covers the libraries underneath them. So a cron that
 * 500s at 02:40 would report a failed run on Vercel's dashboard and nowhere
 * else, and the first symptom would be members silently unable to check in
 * (see the header of app/api/cron/class-instances/route.ts for exactly that
 * failure happening once already).
 *
 * This file imports each handler and calls it with a `Request` carrying the
 * header Vercel actually sends — `Authorization: Bearer ${CRON_SECRET}` — and
 * asserts on the status AND the JSON body, not on "nothing threw".
 *
 * ## What is real and what is stubbed, and why
 *
 * REAL: the database. Every query in these routes runs against the Neon test
 * branch via TEST_DATABASE_URL, which is the half most likely to break — the
 * `withRlsBypass` tenant enumeration, the `withTenantContext` per-tenant work,
 * the chunked deletes, the `createMany({ skipDuplicates })` that only became
 * idempotent with migration 20260819090000.
 *
 * STUBBED, at the process boundary only:
 *  - `@/lib/ai-causal-report` — the real `generateMonthlyReport` calls the
 *    Anthropic API. A test must not spend money or depend on a third party's
 *    latency. The stub REJECTS, which is deliberate twice over: the route's
 *    per-tenant try/catch is exercised, and no `MonthlyReport` row is written,
 *    so this file mutates nothing in that route. The consequence asserted is
 *    the response body's `failures` array.
 *  - `@/lib/stripe/reconcile` — same reasoning, and it is imported by BOTH
 *    cron/stripe-reconcile and cron/retention (retention runs reconciliation
 *    as its first step because the Hobby plan only allows two cron entries).
 *  - `next/server` — `NextResponse.json` is reduced to a plain object, the
 *    pattern tests/integration/push-subscribe.test.ts already established, so
 *    the assertions read the status and body without a fetch layer.
 *
 * ## What this file DOES mutate
 *
 * `cron/class-instances` genuinely inserts ClassInstance rows for the 56-day
 * rolling horizon, and `cron/retention` genuinely deletes rows past their
 * published retention windows. Both are the product's own nightly behaviour
 * and both are idempotent. Before writing this file the test branch was
 * checked for the one irreversible case — tenants soft-deleted more than 30
 * days ago, which `purgeSoftDeletedTenants` hard-deletes — and there were
 * zero (and zero soft-deleted tenants at all, and zero AuditLog rows older
 * than 365 days). If that ever stops being true, this file will hard-delete a
 * tenant on the test branch. The guard below asserts the count is still zero
 * BEFORE the retention call, and fails loudly rather than purging.
 *
 * Run it the way the other real-DB files are run:
 *   TEST_DATABASE_URL="$(grep TEST_DATABASE_URL .env.test | cut -d= -f2-)" \
 *     npx vitest run tests/integration/cron-smoke.test.ts
 */
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (b: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => b,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/lib/ai-causal-report", () => ({
  generateMonthlyReport: vi.fn(async () => {
    throw new Error("stubbed in cron-smoke: no Anthropic call, and no MonthlyReport row written");
  }),
}));

vi.mock("@/lib/stripe/reconcile", () => ({
  runStripeReconciliation: vi.fn(async () => ({ stubbed: true as const })),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as classInstancesCron } from "@/app/api/cron/class-instances/route";
import { GET as retentionCron } from "@/app/api/cron/retention/route";
import { GET as monthlyReportsCron } from "@/app/api/cron/monthly-reports/route";
import { GET as stripeReconcileCron } from "@/app/api/cron/stripe-reconcile/route";

const HAS_DB = !!process.env.DATABASE_URL;
const SECRET = "cron-smoke-not-a-real-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

type CronHandler = (req: Request) => Promise<{ status: number; json: () => Promise<unknown> }>;

const ROUTES: Array<[string, CronHandler]> = [
  ["/api/cron/class-instances", classInstancesCron as unknown as CronHandler],
  ["/api/cron/retention", retentionCron as unknown as CronHandler],
  ["/api/cron/monthly-reports", monthlyReportsCron as unknown as CronHandler],
  ["/api/cron/stripe-reconcile", stripeReconcileCron as unknown as CronHandler],
];

/** Exactly what Vercel's scheduler sends: a GET with a bearer token. */
function cronReq(path: string, authorization?: string): Request {
  return new Request(`https://matflow.test${path}`, {
    method: "GET",
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

describe.skipIf(!HAS_DB)("Vercel cron entrypoints", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const name of ["CRON_SECRET", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY"]) {
      saved[name] = process.env[name];
    }
    process.env.CRON_SECRET = SECRET;
    // Both are presence-checked by their routes and never used here: the
    // libraries that would consume them are mocked above. Placeholder values,
    // not credentials.
    process.env.ANTHROPIC_API_KEY = "cron-smoke-placeholder-not-a-key";
    process.env.STRIPE_SECRET_KEY = "cron-smoke-placeholder-not-a-key";
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  // ── The door ──────────────────────────────────────────────────────────────

  it.each(ROUTES)("%s refuses an unauthenticated request", async (_path, handler) => {
    const res = await handler(cronReq("/x"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it.each(ROUTES)("%s refuses a wrong bearer", async (_path, handler) => {
    const res = await handler(cronReq("/x", "Bearer not-the-secret"));
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)("%s reports 503 rather than running when CRON_SECRET is unset", async (_path, handler) => {
    delete process.env.CRON_SECRET;
    try {
      const res = await handler(cronReq("/x", `Bearer ${SECRET}`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "CRON_SECRET not configured" });
    } finally {
      process.env.CRON_SECRET = SECRET;
    }
  });

  // ── The work ──────────────────────────────────────────────────────────────

  it(
    "class-instances generates the rolling horizon and reports the counts",
    async () => {
      const before = await withRlsBypass((tx) => tx.classInstance.count());

      const res = await classInstancesCron(cronReq("/api/cron/class-instances", `Bearer ${SECRET}`));
      const body = (await res.json()) as {
        ok: boolean;
        windowDays: number;
        tenantsProcessed: number;
        created: number;
        results: Array<{ tenantId: string; created?: number; error?: string; skipped?: boolean }>;
      };
      console.log("[cron-smoke] class-instances →", res.status, JSON.stringify({
        ok: body.ok,
        windowDays: body.windowDays,
        tenantsProcessed: body.tenantsProcessed,
        created: body.created,
        errors: body.results.filter((r) => r.error),
        skipped: body.results.filter((r) => r.skipped).length,
      }));

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.results.filter((r) => r.error)).toEqual([]);
      expect(body.windowDays).toBe(56);
      expect(body.tenantsProcessed).toBeGreaterThan(0);

      // The consequence, in Postgres — not the status code. `created` is what
      // the route claims it inserted; the table has to agree.
      const after = await withRlsBypass((tx) => tx.classInstance.count());
      expect(after - before).toBe(body.created);

      // And it is idempotent: the unique index added in migration
      // 20260819090000 is the only thing standing between this cron and a
      // duplicated horizon every night. A second run must create nothing.
      const second = await classInstancesCron(cronReq("/api/cron/class-instances", `Bearer ${SECRET}`));
      const secondBody = (await second.json()) as { ok: boolean; created: number };
      expect(second.status).toBe(200);
      expect(secondBody.created).toBe(0);
      expect(await withRlsBypass((tx) => tx.classInstance.count())).toBe(after);
    },
    240_000,
  );

  it(
    "retention sweeps every rule without a single one erroring",
    async () => {
      // Fail closed before anything irreversible. purgeSoftDeletedTenants
      // hard-deletes up to 2 tenants per run, and nothing brings one back.
      const purgeable = await withRlsBypass((tx) =>
        tx.tenant.count({ where: { deletedAt: { not: null, lt: new Date(Date.now() - 30 * DAY_MS) } } }),
      );
      expect(
        purgeable,
        "The test branch now holds tenant(s) soft-deleted over 30 days ago. Running the " +
          "retention cron here would HARD-DELETE them. Clear or re-date them deliberately " +
          "before running this test.",
      ).toBe(0);

      const res = await retentionCron(cronReq("/api/cron/retention", `Bearer ${SECRET}`));
      const body = (await res.json()) as {
        ok: boolean;
        elapsedMs: number;
        reconcile: unknown;
        results: Array<{ rule: string; deleted?: number; error?: string; skipped?: boolean; partial?: boolean }>;
      };
      console.log("[cron-smoke] retention →", res.status, JSON.stringify({
        ok: body.ok,
        elapsedMs: body.elapsedMs,
        reconcile: body.reconcile,
        results: body.results,
      }));

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.results.filter((r) => r.error)).toEqual([]);
      // Every rule declared in the route must have reported. Silence from a
      // rule is the failure mode this test exists to catch.
      expect(body.results.map((r) => r.rule)).toEqual([
        "auditLog",
        "emailLog",
        "magicLinkToken",
        "passwordResetToken",
        "rateLimitHit",
        "stripeEvent",
        "importJob",
        "importJobDiagnostics",
        "tenantHardDelete",
      ]);
      expect(body.results.filter((r) => r.skipped)).toEqual([]);
    },
    240_000,
  );

  it(
    "monthly-reports enumerates every active tenant and survives a generator that throws",
    async () => {
      const before = await withRlsBypass((tx) => tx.monthlyReport.count());

      const res = await monthlyReportsCron(cronReq("/api/cron/monthly-reports", `Bearer ${SECRET}`));
      const body = (await res.json()) as {
        ok: boolean;
        tenantsProcessed: number;
        succeeded: number;
        failures: Array<{ tenantId: string; error: string }>;
      };
      console.log("[cron-smoke] monthly-reports →", res.status, JSON.stringify({
        ok: body.ok,
        tenantsProcessed: body.tenantsProcessed,
        succeeded: body.succeeded,
        failureCount: body.failures.length,
      }));

      expect(body.tenantsProcessed).toBeGreaterThan(0);
      // The generator was stubbed to reject, so every tenant must appear as a
      // failure and NOTHING may have been written.
      expect(body.succeeded).toBe(0);
      expect(body.failures).toHaveLength(body.tenantsProcessed);
      expect(await withRlsBypass((tx) => tx.monthlyReport.count())).toBe(before);

      // Same rule as cron/retention and cron/class-instances: "200 + ok:false
      // is invisible to every uptime check". Until X-6 this route returned 200
      // with a literal `ok: true` even when every single tenant failed — as it
      // just did — so Vercel's cron dashboard showed the run green. A run with
      // failures is a 500 with `ok: false`; reverting the route's status
      // derivation turns this red.
      expect(body.ok).toBe(false);
      expect(res.status).toBe(500);
    },
    120_000,
  );

  it("stripe-reconcile answers on the ad-hoc path", async () => {
    const res = await stripeReconcileCron(cronReq("/api/cron/stripe-reconcile", `Bearer ${SECRET}`));
    const body = await res.json();
    console.log("[cron-smoke] stripe-reconcile →", res.status, JSON.stringify(body));
    expect(res.status).toBe(200);
    // The reconciliation itself is mocked (it talks to Stripe), so this proves
    // the auth gate, the STRIPE_SECRET_KEY guard and the response plumbing —
    // NOT the reconciliation logic, which lib/stripe/reconcile.ts owns.
    expect(body).toEqual({ stubbed: true });
  });

  it("stripe-reconcile reports 503 rather than running when Stripe is unconfigured", async () => {
    const savedKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const res = await stripeReconcileCron(cronReq("/api/cron/stripe-reconcile", `Bearer ${SECRET}`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Stripe not configured" });
    } finally {
      process.env.STRIPE_SECRET_KEY = savedKey;
    }
  });

  it("monthly-reports reports 503 rather than running when the AI key is unset", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await monthlyReportsCron(cronReq("/api/cron/monthly-reports", `Bearer ${SECRET}`));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "AI service not configured. Set ANTHROPIC_API_KEY." });
    } finally {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});
