// Lane PA request (11 Oct 2026): a successful OAuth (re)connect must clear the cached Stripe
// account status, otherwise a webhook "deauthorized" stamp keeps the guard refusing the club
// for up to 24 h after it has reconnected. Pins the update payload of the callback route.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";

const tenantUpdate = vi.fn(async (args: unknown) => args);

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "unit-test-secret-value-0123456789" }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn({ tenant: { update: tenantUpdate } }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("stripe", () => ({
  default: class {
    oauth = { token: vi.fn(async () => ({ stripe_user_id: "acct_reconnect_1" })) };
  },
}));

describe("GET /api/stripe/connect/callback", () => {
  beforeEach(() => {
    tenantUpdate.mockClear();
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  });

  it("clears the cached account status when a club (re)connects", async () => {
    const { GET } = await import("@/app/api/stripe/connect/callback/route");
    const ts = Date.now();
    const payload = `t1:${ts}`;
    const sig = createHmac("sha256", "unit-test-secret-value-0123456789").update(payload).digest("hex");
    const url = `http://localhost/api/stripe/connect/callback?code=ac_test&state=${sig}:${payload}`;
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(url));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("connected=true");
    expect(tenantUpdate).toHaveBeenCalledTimes(1);
    const args = tenantUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(args.data.stripeAccountId).toBe("acct_reconnect_1");
    expect(args.data.stripeConnected).toBe(true);
    expect("stripeAccountStatus" in args.data).toBe(true);
    // Prisma.DbNull is a sentinel object; it must be present and must not be undefined.
    expect(args.data.stripeAccountStatus).not.toBeUndefined();
  });
});
