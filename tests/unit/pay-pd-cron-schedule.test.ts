// Payments lane PD (11 Oct 2026) — reconciliation has its own schedule and its
// own switch. Audit §14 / F3: it ran only inside the retention cron, behind
// RETENTION_CRON_ENABLED, and was never scheduled on its own, so in production
// it never ran. Pinned here: vercel.json schedules /api/cron/stripe-reconcile
// daily; the retention entry is unchanged; the route's gate is its own
// variable, exactly "true", checked after the bearer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const run = vi.hoisted(() => vi.fn(async () => ({ ok: true, runId: "run-1", errors: [] as unknown[] })));
vi.mock("@/lib/stripe/reconcile", () => ({ runStripeReconciliation: run }));
vi.mock("@/lib/rate-limit", () => ({ checkCronAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b }) },
}));

import { GET } from "@/app/api/cron/stripe-reconcile/route";

const vercel = JSON.parse(readFileSync(resolve(__dirname, "../../vercel.json"), "utf8")) as {
  crons: Array<{ path: string; schedule: string }>;
};
const req = (auth?: string) =>
  new Request("https://matflow.test/api/cron/stripe-reconcile", auth ? { headers: { authorization: auth } } : {});
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["CRON_SECRET", "STRIPE_SECRET_KEY", "STRIPE_RECONCILE_ENABLED", "RETENTION_CRON_ENABLED"]) saved[k] = process.env[k];
  process.env.CRON_SECRET = "pay-pd-cron-test-bearer";
  process.env.STRIPE_SECRET_KEY = "pay-pd-placeholder-not-a-key";
  delete process.env.STRIPE_RECONCILE_ENABLED;
  delete process.env.RETENTION_CRON_ENABLED;
  run.mockClear();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("pay-pd: the reconcile schedule", () => {
  it("vercel.json schedules /api/cron/stripe-reconcile once a day", () => {
    const entry = vercel.crons.find((c) => c.path === "/api/cron/stripe-reconcile");
    expect(entry).toBeDefined();
    const [minute, hour, dom, month, dow] = entry!.schedule.split(" ");
    expect(Number.isInteger(Number(minute)) && Number.isInteger(Number(hour))).toBe(true);
    expect([dom, month, dow]).toEqual(["*", "*", "*"]);
  });

  it("the retention entry is untouched", () => {
    expect(vercel.crons.find((c) => c.path === "/api/cron/retention")).toEqual({ path: "/api/cron/retention", schedule: "30 3 * * *" });
  });

  it("is OFF by default: 503 and nothing runs, even with the retention switch on", async () => {
    process.env.RETENTION_CRON_ENABLED = "true";
    const res = await GET(req("Bearer pay-pd-cron-test-bearer"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "stripe reconcile cron disabled" });
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["1", "TRUE", "yes", " true", ""])("STRIPE_RECONCILE_ENABLED=%j is not on", async (v) => {
    process.env.STRIPE_RECONCILE_ENABLED = v;
    expect((await GET(req("Bearer pay-pd-cron-test-bearer"))).status).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("exactly \"true\" runs it as a cron run; per-club errors answer 500 ok:false", async () => {
    process.env.STRIPE_RECONCILE_ENABLED = "true";
    const ok = await GET(req("Bearer pay-pd-cron-test-bearer"));
    expect(ok.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ trigger: "cron" });
    run.mockResolvedValueOnce({ ok: true, runId: "run-2", errors: [{ tenantId: "t", error: "x" }] });
    const bad = await GET(req("Bearer pay-pd-cron-test-bearer"));
    expect(bad.status).toBe(500);
    expect(await bad.json()).toMatchObject({ ok: false, runId: "run-2" });
  });

  it("the gate is checked after the bearer: a wrong bearer is 401 whatever the switch says", async () => {
    process.env.STRIPE_RECONCILE_ENABLED = "true";
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    delete process.env.STRIPE_RECONCILE_ENABLED;
    expect((await GET(req())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
});
