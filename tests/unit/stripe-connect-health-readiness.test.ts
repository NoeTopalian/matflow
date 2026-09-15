// `GET /api/stripe/connect/health` decides, for the operator, whether Stripe is
// set up. `docs/runbooks/GO-LIVE-2026-09.md` says so in terms: "Do not treat
// Stripe as set up until this endpoint says ready: true. It exists precisely so
// this is not a matter of opinion."
//
// It was an opinion. `ready` was computed from four presence checks plus a live
// API call, and a TEST key authenticates against Stripe's test API perfectly —
// so a production deployment configured with sk_test_ returned ready:true while
// being structurally incapable of taking one real payment. Every card would work
// in testing and no money would ever arrive.
//
// tests/unit/stripe-key-mode.test.ts proves the classification. This proves the
// ROUTE uses it — the wiring, which is the half a pure-function test cannot see
// and the half that was missing.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, tenantId: "tenant_1" }),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: {
        findUnique: async () => ({
          stripeConnected: false,
          stripeAccountId: "acct_1234567890",
          stripeAccountStatus: null,
          acceptsBacs: false,
        }),
      },
    }),
}));

vi.mock("@/lib/env-url", () => ({ getBaseUrl: () => "https://matflow.studio" }));

// The live probe is stubbed to SUCCEED throughout. That is deliberate: a test
// key really does authenticate cleanly, so the probe passing is exactly the
// condition under which the old readiness check said yes. If `ready` still came
// back true here, the bug would be intact.
vi.mock("stripe", () => ({
  default: class {
    accounts = { list: async () => ({ data: [] }) };
    balance = { retrieve: async () => ({ available: [{ currency: "gbp" }] }) };
  },
}));

import { GET } from "@/app/api/stripe/connect/health/route";

const ORIGINAL = { ...process.env };

function configure(over: Record<string, string | undefined>) {
  process.env.STRIPE_CLIENT_ID = "ca_UQjg8IIm9jUVnjEN9wYIttkaIiJcLrBy";
  process.env.STRIPE_SECRET_KEY = "sk_test_abc123";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_abc123";
  process.env.NEXTAUTH_URL = "https://matflow.studio";
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function health() {
  const res = await GET(new Request("https://matflow.studio/api/stripe/connect/health"));
  return (await res.json()) as {
    ready: boolean;
    env: { STRIPE_SECRET_KEY: { mode: string | null; kind: string | null; environment: string; belongsInThisEnvironment: boolean } };
    nextSteps: string[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /api/stripe/connect/health — readiness", () => {
  it("is NOT ready when production holds a TEST key", async () => {
    // The defect, stated as a test. Everything else about this configuration is
    // correct and the live probe succeeds; only the mode is wrong.
    configure({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "sk_test_abc123" });
    const body = await health();

    expect(body.ready, "a production deploy on a test key takes no money and must not read as ready").toBe(false);
    expect(body.env.STRIPE_SECRET_KEY.mode).toBe("test");
    expect(body.env.STRIPE_SECRET_KEY.environment).toBe("production");
    expect(body.env.STRIPE_SECRET_KEY.belongsInThisEnvironment).toBe(false);
    expect(
      body.nextSteps.join(" "),
      "the operator must be told what is wrong, not just handed a false",
    ).toMatch(/PRODUCTION deployment and STRIPE_SECRET_KEY is a TEST key/);
  });

  it("IS ready when production holds the restricted LIVE key the account actually has", async () => {
    // The other half of the same bug: `rk_live_` matched neither old branch and
    // reported mode "unknown". A correct configuration must read as correct, or
    // the operator learns to ignore the endpoint.
    configure({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "rk_live_51T87S7J74LmUlLwB" });
    const body = await health();

    expect(body.ready).toBe(true);
    expect(body.env.STRIPE_SECRET_KEY.mode).toBe("live");
    expect(body.env.STRIPE_SECRET_KEY.kind).toBe("restricted");
  });

  it("is NOT ready when a preview or laptop holds a LIVE key", async () => {
    configure({ VERCEL_ENV: "preview", STRIPE_SECRET_KEY: "sk_live_abc123" });
    const body = await health();
    expect(body.ready, "a preview on a live key charges real cards").toBe(false);
    expect(body.nextSteps.join(" ")).toMatch(/LIVE key/);
  });

  it("is NOT ready when the publishable key was pasted into the secret slot", async () => {
    configure({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "pk_live_51T87S7J74LmUlLwB" });
    const body = await health();
    expect(body.ready).toBe(false);
    expect(body.env.STRIPE_SECRET_KEY.kind).toBe("publishable");
    expect(body.nextSteps.join(" ")).toMatch(/PUBLISHABLE key/);
  });

  it("is NOT ready with no webhook secret — the state production shipped in", async () => {
    // Production has held an empty STRIPE_WEBHOOK_SECRET for the product's whole
    // life, so every webhook 400s and no payment has ever been recorded.
    configure({ VERCEL_ENV: "production", STRIPE_SECRET_KEY: "rk_live_abc", STRIPE_WEBHOOK_SECRET: undefined });
    const body = await health();
    expect(body.ready).toBe(false);
    expect(body.nextSteps.join(" ")).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  it("is ready on a laptop with a test key, so local work is not flagged as broken", async () => {
    configure({ VERCEL_ENV: undefined, NODE_ENV: "development", STRIPE_SECRET_KEY: "sk_test_abc123" });
    const body = await health();
    expect(body.ready).toBe(true);
    expect(body.env.STRIPE_SECRET_KEY.environment).toBe("development");
  });
});
