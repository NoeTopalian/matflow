import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * P0 — createSubscriptionForMember must read the client secret from
 * `latest_invoice.confirmation_secret`, not `latest_invoice.payment_intent`.
 *
 * On the pinned API version (2026-03-25.dahlia) the Invoice object has NO
 * `payment_intent` field at all. Stripe accepts `latest_invoice.payment_intent`
 * as an expand path without erroring and simply never populates it, so the old
 * code returned `clientSecret: null` on every subscription ever created. The
 * client could never confirm the PaymentIntent, so the subscription sat
 * `incomplete` until Stripe expired it — recurring billing never worked.
 *
 * Verified live against a test Connect account on 2026-08-18:
 *   expand ["latest_invoice.confirmation_secret"]
 *     -> confirmation_secret.client_secret = "pi_…_secret_…"  (a PaymentIntent
 *        client secret, byte-identical to the PaymentIntent's own)
 *     -> "payment_intent" key absent from the invoice entirely
 *
 * These tests fail if anyone regresses the expand path or the read back to
 * `payment_intent`, and if a missing secret is ever reported as success again.
 */

const {
  customersCreateMock,
  subscriptionsCreateMock,
  stripeCtorMock,
  memberUpdateMock,
  memberUpdateManyMock,
  memberFindUniqueMock,
} = vi.hoisted(() => ({
  customersCreateMock: vi.fn(),
  subscriptionsCreateMock: vi.fn(),
  stripeCtorMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  memberUpdateManyMock: vi.fn(),
  memberFindUniqueMock: vi.fn(),
}));

const fakeTx = {
  member: {
    update: memberUpdateMock,
    updateMany: memberUpdateManyMock,
    findUnique: memberFindUniqueMock,
  },
};

// The helper does `new Stripe(key, { apiVersion })`, so the mock has to be
// constructible — a `function` implementation, not an arrow.
function applyStripeStub() {
  stripeCtorMock.mockImplementation(function (this: Record<string, unknown>) {
    this.customers = { create: customersCreateMock };
    this.subscriptions = { create: subscriptionsCreateMock };
  });
}
applyStripeStub();

vi.mock("stripe", () => ({ default: stripeCtorMock }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));

import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";

const TENANT = {
  id: "tenant-A",
  stripeAccountId: "acct_gym_123",
  acceptsBacs: true,
};
const MEMBER = {
  id: "mem-1",
  email: "sam@gym.test",
  name: "Sam Fighter",
  stripeCustomerId: "cus_existing",
};
const PRICE = "price_monthly_25";

// A real secret from the live verification run — shape matters (pi_…_secret_…).
const REAL_SECRET = "pi_3U5iHIJnyjViQoWL133Bauh6_secret_zxkPKUSA2izcYuN6L4jN2aQwR";

/** An invoice as 2026-03-25.dahlia actually returns it. */
function dahliaInvoice(clientSecret: string = REAL_SECRET) {
  return {
    id: "in_test_1",
    status: "open",
    amount_due: 2500,
    confirmation_secret: { client_secret: clientSecret, type: "payment_intent" },
  };
}

function call(overrides: Partial<Parameters<typeof createSubscriptionForMember>[0]> = {}) {
  return createSubscriptionForMember({
    tenant: TENANT,
    member: MEMBER,
    priceId: PRICE,
    paymentMethodType: "card",
    ...overrides,
  });
}

const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  applyStripeStub();
  memberUpdateMock.mockResolvedValue({ id: MEMBER.id });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
});

describe("createSubscriptionForMember — confirmation_secret read path (P0)", () => {
  it("returns the client secret from latest_invoice.confirmation_secret", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      status: "incomplete",
      latest_invoice: dahliaInvoice(),
    });

    const outcome = await call();

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.clientSecret).toBe(REAL_SECRET);
    expect(outcome.subscriptionId).toBe("sub_test_1");
    expect(outcome.customerId).toBe("cus_existing");
  });

  it("expands latest_invoice.confirmation_secret, NOT latest_invoice.payment_intent", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: dahliaInvoice(),
    });

    await call();

    const [params, options] = subscriptionsCreateMock.mock.calls[0];
    expect(params.expand).toContain("latest_invoice.confirmation_secret");
    // The regression guard: this expand path is silently ignored by Stripe on
    // the pinned API version and must never come back.
    expect(params.expand).not.toContain("latest_invoice.payment_intent");
    // stripeAccount is the THIRD argument (request options), not part of params.
    expect(options).toEqual({ stripeAccount: TENANT.stripeAccountId });
    expect(params).not.toHaveProperty("stripeAccount");
  });

  it("pins the API version the confirmation_secret shape was verified against", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: dahliaInvoice(),
    });

    await call();

    expect(stripeCtorMock).toHaveBeenCalledWith(
      "sk_test_dummy",
      expect.objectContaining({ apiVersion: "2026-03-25.dahlia" }),
    );
  });

  it("does NOT read a legacy payment_intent secret (proves the old path is gone)", async () => {
    // Exactly the shape the old code — and the old test fixtures — assumed.
    // Stripe never returns this on 2026-03-25.dahlia, so treating it as a
    // success would mean the read path had regressed.
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: {
        id: "in_test_1",
        payment_intent: { client_secret: "pi_legacy_secret_should_be_ignored" },
      },
    });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("legacy payment_intent must not be accepted");
    expect(outcome.status).toBe(502);
  });
});

describe("createSubscriptionForMember — a missing secret is a real failure", () => {
  it("fails with 502 when confirmation_secret is absent", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: { id: "in_test_1", status: "open" },
    });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.status).toBe(502);
    expect(outcome.error).toMatch(/payment/i);
  });

  it("fails when confirmation_secret is present but null", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: { id: "in_test_1", confirmation_secret: null },
    });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
  });

  it("fails when latest_invoice came back unexpanded (a bare id string)", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: "in_test_1",
    });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.status).toBe(502);
  });

  it("fails when latest_invoice is null", async () => {
    subscriptionsCreateMock.mockResolvedValue({ id: "sub_test_1", latest_invoice: null });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
  });

  it("does NOT persist stripeSubscriptionId when there is no usable secret", async () => {
    // hasActiveSubscription is derived from !!member.stripeSubscriptionId, so
    // persisting here would show the member an "Active" subscription that can
    // never be paid.
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_1",
      latest_invoice: { id: "in_test_1" },
    });

    const outcome = await call();

    expect(outcome.ok).toBe(false);
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });
});

describe("createSubscriptionForMember — persistence on success", () => {
  it("persists stripeSubscriptionId and preferredPaymentMethod", async () => {
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_9",
      latest_invoice: dahliaInvoice(),
    });

    await call({ paymentMethodType: "bacs_debit" });

    expect(memberUpdateMock).toHaveBeenCalledWith({
      where: { id: MEMBER.id },
      data: { stripeSubscriptionId: "sub_test_9", preferredPaymentMethod: "bacs_debit" },
    });
  });

  it("creates the Stripe customer on the connected account when the member has none", async () => {
    customersCreateMock.mockResolvedValue({ id: "cus_new" });
    memberUpdateManyMock.mockResolvedValue({ count: 1 });
    subscriptionsCreateMock.mockResolvedValue({
      id: "sub_test_2",
      latest_invoice: dahliaInvoice(),
    });

    const outcome = await call({ member: { ...MEMBER, stripeCustomerId: null } });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.customerId).toBe("cus_new");
    // Same third-argument trap as subscriptions.create.
    expect(customersCreateMock).toHaveBeenCalledWith(
      { email: MEMBER.email, name: MEMBER.name },
      { stripeAccount: TENANT.stripeAccountId },
    );
  });
});
