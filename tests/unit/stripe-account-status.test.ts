import { vi, describe, it, expect, beforeEach } from "vitest";

// Fix 3 — Stripe Connect capability gate. Verifies that the cached
// Tenant.stripeAccountStatus controls whether checkout / class-pack /
// subscription routes accept charges, and that account.updated webhooks
// refresh it.

// refreshStripeAccountStatus persists through withTenantContext, which runs the
// callback inside `prisma.$transaction` and issues a `set_config` via
// `tx.$executeRaw` first (lib/prisma-tenant.ts:45-48). A mock with only
// `tenant.update` therefore threw "prisma.$transaction is not a function" on
// every refresh. The throw was swallowed by the catch at
// lib/stripe-account-status.ts:74 — so the tests still passed while the persist
// half of the function was never actually exercised, and CI logs filled with
// "[stripe-account-status] persist failed". The mock now carries the shape the
// code really uses.
//
// The transactional spies are deliberately DISTINCT from the bare-client one.
// Sharing a single vi.fn() between `prisma.tenant.update` and `tx.tenant.update`
// makes the persist assertion pass even if the code bypasses withTenantContext
// and writes straight through the client — which would skip the RLS
// `set_config` entirely. On a branch about tenant-isolation honesty the spy has
// to be able to tell those two apart.
const { txTenantUpdate, txExecuteRaw, bareTenantUpdate } = vi.hoisted(() => ({
  txTenantUpdate: vi.fn().mockResolvedValue({}),
  txExecuteRaw: vi.fn().mockResolvedValue(0),
  bareTenantUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    $executeRaw: txExecuteRaw,
    tenant: { update: txTenantUpdate },
  };
  return {
    prisma: {
      // Must stay unused: every write in lib/stripe-account-status.ts goes
      // through withTenantContext.
      tenant: { update: bareTenantUpdate },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canAcceptCharges (pure check)", () => {
  it("returns false for null / undefined / non-object", async () => {
    const { canAcceptCharges } = await import("@/lib/stripe-account-status");
    expect(canAcceptCharges(null)).toBe(false);
    expect(canAcceptCharges(undefined)).toBe(false);
    expect(canAcceptCharges("string")).toBe(false);
    expect(canAcceptCharges(42)).toBe(false);
  });

  it("returns false when chargesEnabled is false / missing", async () => {
    const { canAcceptCharges } = await import("@/lib/stripe-account-status");
    expect(canAcceptCharges({})).toBe(false);
    expect(canAcceptCharges({ chargesEnabled: false })).toBe(false);
    expect(canAcceptCharges({ payoutsEnabled: true })).toBe(false);
  });

  it("returns true when chargesEnabled is exactly true", async () => {
    const { canAcceptCharges } = await import("@/lib/stripe-account-status");
    expect(canAcceptCharges({ chargesEnabled: true })).toBe(true);
    expect(canAcceptCharges({ chargesEnabled: true, payoutsEnabled: false })).toBe(true);
  });

  it("rejects truthy non-boolean chargesEnabled (no coercion — strict ===)", async () => {
    const { canAcceptCharges } = await import("@/lib/stripe-account-status");
    expect(canAcceptCharges({ chargesEnabled: "true" })).toBe(false);
    expect(canAcceptCharges({ chargesEnabled: 1 })).toBe(false);
  });
});

describe("ensureCanAcceptCharges (cache-aware)", () => {
  it("uses cached status when fresh and skips refresh", async () => {
    const { ensureCanAcceptCharges } = await import("@/lib/stripe-account-status");
    const fresh = {
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsPastDue: [],
      disabledReason: null,
      refreshedAt: new Date().toISOString(),
    };
    const result = await ensureCanAcceptCharges("tenant-A", "acct_123", fresh);
    expect(result.ok).toBe(true);
    expect(result.status).toEqual(fresh);
  });

  it("returns ok=false when cached status says chargesEnabled=false (and is fresh)", async () => {
    const { ensureCanAcceptCharges } = await import("@/lib/stripe-account-status");
    const restricted = {
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsPastDue: ["external_account"],
      disabledReason: "requirements.past_due",
      refreshedAt: new Date().toISOString(),
    };
    const result = await ensureCanAcceptCharges("tenant-A", "acct_123", restricted);
    expect(result.ok).toBe(false);
  });

  it("triggers refresh when cached status is stale (>24h)", async () => {
    const { ensureCanAcceptCharges } = await import("@/lib/stripe-account-status");
    const stale = {
      chargesEnabled: true,
      payoutsEnabled: true,
      requirementsPastDue: [],
      disabledReason: null,
      refreshedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    };
    // refresh path with no STRIPE_SECRET_KEY → returns safe-deny status
    delete process.env.STRIPE_SECRET_KEY;
    const result = await ensureCanAcceptCharges("tenant-A", "acct_123", stale);
    expect(result.ok).toBe(false);
    expect(result.status?.disabledReason).toBe("stripe_not_configured");
  });

  it("triggers refresh when cached status is null (first checkout for tenant)", async () => {
    const { ensureCanAcceptCharges } = await import("@/lib/stripe-account-status");
    delete process.env.STRIPE_SECRET_KEY;
    const result = await ensureCanAcceptCharges("tenant-A", "acct_123", null);
    expect(result.ok).toBe(false);
    expect(result.status?.refreshedAt).toBeDefined();
  });
});

describe("refreshStripeAccountStatus (safe-deny on errors)", () => {
  it("returns chargesEnabled=false + disabledReason='stripe_not_configured' when STRIPE_SECRET_KEY unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { refreshStripeAccountStatus } = await import("@/lib/stripe-account-status");
    const result = await refreshStripeAccountStatus("tenant-A", "acct_123");
    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.disabledReason).toBe("stripe_not_configured");
    expect(result.refreshedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The safe-deny status must actually reach the Tenant row — otherwise the
    // next checkout re-runs the whole refresh. These assertions are what keep
    // the prisma mock honest: with the old `$transaction`-less mock the persist
    // threw, was swallowed, and nothing here noticed.
    //
    // The tenant predicate must reach the QUERY, not merely the where clause:
    // withTenantContext issues `set_config('app.current_tenant_id', $1, true)`
    // (lib/prisma-tenant.ts:46) so the RLS policies apply to the write. Assert
    // the tenant id actually arrives as that bind parameter.
    expect(txExecuteRaw).toHaveBeenCalledWith(expect.anything(), "tenant-A");
    expect(txTenantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "tenant-A" },
        data: expect.objectContaining({
          stripeAccountStatus: expect.objectContaining({
            chargesEnabled: false,
            disabledReason: "stripe_not_configured",
          }),
        }),
      }),
    );
    // …and it must NOT have gone straight through the client, which would skip
    // the set_config above and leave the write outside RLS.
    expect(bareTenantUpdate).not.toHaveBeenCalled();
  });
});
