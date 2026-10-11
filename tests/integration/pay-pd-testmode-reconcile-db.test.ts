// Payments lane PD (11 Oct 2026) — reconciliation against REAL Stripe TEST MODE
// and the REAL test database. Opt-in: runs only with PAY_PD_STRIPE_TESTMODE=1
// through a guarded runner, and refuses unless .env.test holds a test-mode
// secret key (sk_test_). Never prints the key. Read-only on Stripe (events and
// subscriptions/charges are listed or retrieved as the connected account).
//
// What it proves that the mocked suites cannot: List Events must be called AS
// the connected account (Stripe-Account) to see a Standard account's events
// (audit S3 U6), the shapes the reconcile code reads are the shapes Stripe
// returns, and a full run over a real account records every handled event the
// store lacks as `received` (attempts 0, reconcileFoundAt) and processes none.
// Everything this file writes on the TEST branch is removed afterwards.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { HANDLED_STRIPE_EVENT_TYPES } from "@/lib/stripe/handled-events";
import { runStripeReconciliation, type ReconcileStripe } from "@/lib/stripe/reconcile";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const RUN = process.env.PAY_PD_STRIPE_TESTMODE === "1" && !!process.env.DATABASE_URL;

function testKey(): string {
  const line = readFileSync(resolve(__dirname, "../../.env.test"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("STRIPE_SECRET_KEY="));
  const key = (line ?? "").slice("STRIPE_SECRET_KEY=".length).trim().replace(/^"|"$/g, "");
  if (!key.startsWith("sk_test_")) throw new Error("REFUSED: .env.test STRIPE_SECRET_KEY is not a test-mode secret key");
  return key;
}

describe.skipIf(!RUN)("pay-pd: reconciliation against Stripe test mode", () => {
  const started = new Date();
  let acct = "";
  let tenantId = "";
  let createdTenant = false;
  let connected = true;
  let real: ReconcileStripe;
  const calls: string[] = [];
  /** The real SDK, with every call's account recorded. */
  const recording = (): ReconcileStripe => ({
    events: { list: (p, o) => { calls.push(`events.list:${o.stripeAccount}`); return real.events.list(p, o); } },
    subscriptions: { retrieve: (id, p, o) => { calls.push(`subscriptions.retrieve:${o.stripeAccount}`); return real.subscriptions.retrieve(id, p, o); } },
    charges: { retrieve: (id, p, o) => { calls.push(`charges.retrieve:${o.stripeAccount}`); return real.charges.retrieve(id, p, o); } },
    paymentIntents: { retrieve: (id, p, o) => { calls.push(`paymentIntents.retrieve:${o.stripeAccount}`); return real.paymentIntents.retrieve(id, p, o); } },
  });
  let runId: string | null = null;
  const savedKey = process.env.STRIPE_SECRET_KEY;

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = testKey();
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
    real = stripe as unknown as ReconcileStripe;
    const accounts = await stripe.accounts.list({ limit: 1 });
    expect(accounts.data.length, "no connected account in test mode").toBeGreaterThan(0);
    acct = accounts.data[0].id;
    const existing = await withRlsBypass((tx) => tx.tenant.findFirst({ where: { stripeAccountId: acct }, select: { id: true, stripeConnected: true } }));
    if (existing) {
      tenantId = existing.id;
      // Not flipped: the club row is a shared fixture on the TEST branch.
      connected = existing.stripeConnected;
    } else {
      tenantId = `paypdtm-${Date.now().toString(36)}`;
      await withRlsBypass((tx) => tx.tenant.create({ data: { id: tenantId, name: "payPD test-mode club", slug: tenantId, stripeAccountId: acct, stripeConnected: true } }));
      createdTenant = true;
    }
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { stripeAccountId: acct, reconcileFoundAt: { gte: started } } });
      if (runId) await tx.stripeReconcileRun.deleteMany({ where: { id: runId } });
      if (createdTenant) await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    process.env.STRIPE_SECRET_KEY = savedKey;
  }, 120_000);

  it("listing works only AS the connected account and returns the shapes reconcile reads", async () => {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    const page = await stripe.events.list({ limit: 20 }, { stripeAccount: acct });
    expect(page.data.length).toBeGreaterThan(0);
    for (const e of page.data) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.type).toBe("string");
      expect(typeof e.created).toBe("number");
      expect(e.livemode).toBe(false);
      expect(typeof e.data.object).toBe("object");
      expect(e.account).toBe(acct);
    }
    const fresh = await stripe.events.retrieve(page.data[0].id, {}, { stripeAccount: acct });
    expect(fresh.id).toBe(page.data[0].id);
    const onPlatform = await stripe.events.retrieve(page.data[0].id).then(() => "found", (e: { code?: string }) => e.code ?? "error");
    expect(onPlatform).toBe("resource_missing");
  }, 120_000);

  it("a full run over the real account: a withdrawn club is reported and never called; a connected one has its missing handled events recorded unprocessed", async () => {
    calls.length = 0;
    const r = await runStripeReconciliation({ trigger: "manual", tenantIds: [tenantId], lookbackMs: 30 * 24 * 3600 * 1000, stripe: recording() });
    runId = r.runId;
    console.log("[pay-pd test-mode] reconcile", JSON.stringify({
      clubConnected: connected, tenantsChecked: r.tenantsChecked, tenantsSkipped: r.tenantsSkipped, eventsScanned: r.eventsScanned,
      missing: r.missingCount, missingTypes: [...new Set(r.missing.map((m) => m.type))], mismatches: r.stateMismatches.length,
      errors: r.errors, stripeCalls: calls.length,
    }));
    expect(r.errors).toEqual([]);
    if (!connected) {
      expect(r.tenantsChecked).toBe(0);
      expect(r.skippedTenants.map((t) => t.tenantId)).toEqual([tenantId]);
      expect(calls).toEqual([]);
      return;
    }
    expect(r.tenantsChecked).toBe(1);
    expect(r.eventsScanned).toBeGreaterThan(0);
    expect(calls.every((c) => c.endsWith(`:${acct}`))).toBe(true);
    for (const m of r.missing) expect(HANDLED_STRIPE_EVENT_TYPES.has(m.type)).toBe(true);
    const rows = await withRlsBypass((tx) =>
      tx.stripeEvent.findMany({ where: { eventId: { in: r.missing.map((m) => m.eventId) } }, select: { status: true, attempts: true, reconcileFoundAt: true, tenantId: true, livemode: true } }),
    );
    expect(rows).toHaveLength(r.missingCount);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "received", attempts: 0, tenantId, livemode: false });
      expect(row.reconcileFoundAt).toBeInstanceOf(Date);
    }
    const again = await runStripeReconciliation({ trigger: "manual", tenantIds: [tenantId], lookbackMs: 30 * 24 * 3600 * 1000, stripe: recording() });
    await withRlsBypass((tx) => tx.stripeReconcileRun.deleteMany({ where: { id: again.runId! } }));
    expect(again.missingCount).toBe(0);
  }, 300_000);
});
