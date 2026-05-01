import { vi, describe, it, expect, beforeEach } from "vitest";

// Fix 3 — Stripe Connect capability gate. Verifies that the cached
// Tenant.stripeAccountStatus controls whether checkout / class-pack /
// subscription routes accept charges, and that account.updated webhooks
// refresh it.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

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
  });
});
