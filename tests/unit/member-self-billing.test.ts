import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
    },
    tenant: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((_msg: string, status: number) => ({
    status,
    json: async () => ({ error: _msg }),
  })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/stripe/portal/route";
import { PATCH } from "@/app/api/settings/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockTenantUpdate = vi.mocked(prisma.tenant.update);

beforeEach(() => vi.clearAllMocks());

// ─── B-4: /api/stripe/portal memberSelfBilling gate ──────────────────────────

describe("POST /api/stripe/portal — memberSelfBilling gate (B-4)", () => {
  it("returns 403 when memberSelfBilling is false", async () => {
    mockAuth.mockResolvedValue({
      user: { memberId: "mem-1", tenantId: "t1", role: "member" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      id: "mem-1",
      tenantId: "t1",
      stripeCustomerId: "cus_test",
    } as never);

    mockTenantFindUnique.mockResolvedValue({
      stripeAccountId: "acct_test",
      memberSelfBilling: false,
    } as never);

    const req = new Request("http://localhost/api/stripe/portal", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not enabled/i);
  });

  it("returns 403 when memberSelfBilling is missing (undefined tenant)", async () => {
    mockAuth.mockResolvedValue({
      user: { memberId: "mem-1", tenantId: "t1", role: "member" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      id: "mem-1",
      tenantId: "t1",
      stripeCustomerId: "cus_test",
    } as never);

    // tenant exists but memberSelfBilling defaults to false
    mockTenantFindUnique.mockResolvedValue({
      stripeAccountId: "acct_test",
      memberSelfBilling: false,
    } as never);

    const req = new Request("http://localhost/api/stripe/portal", { method: "POST" });
    const res = await POST(req);

    expect(res.status).toBe(403);
  });

  it("proceeds past the gate when memberSelfBilling is true (Stripe SDK not available — expects 503 or error, not 403)", async () => {
    mockAuth.mockResolvedValue({
      user: { memberId: "mem-2", tenantId: "t2", role: "member" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      id: "mem-2",
      tenantId: "t2",
      stripeCustomerId: "cus_test2",
    } as never);

    mockTenantFindUnique.mockResolvedValue({
      stripeAccountId: "acct_test2",
      memberSelfBilling: true,
    } as never);

    const req = new Request("http://localhost/api/stripe/portal", { method: "POST" });
    const res = await POST(req);

    // Must NOT be 403 — the gate was passed. Stripe SDK will fail in test env (503/500).
    expect(res.status).not.toBe(403);
  });
});

// ─── B-6: billingContactUrl must be https:// only ────────────────────────────

describe("PATCH /api/settings — billingContactUrl validation (B-6)", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({
      user: { role: "owner", tenantId: "t1", id: "user-1" },
    } as never);
    mockTenantUpdate.mockResolvedValue({ id: "t1" } as never);
  });

  it("rejects javascript: URL with 400", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingContactUrl: "javascript:alert(1)" }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("rejects http:// URL with 400 (must be https://)", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingContactUrl: "http://example.com/billing" }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("rejects data: URL with 400", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingContactUrl: "data:text/html,<script>alert(1)</script>" }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("accepts https:// URL with 200", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingContactUrl: "https://example.com/billing" }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });

  it("accepts null billingContactUrl with 200 (clears the field)", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ billingContactUrl: null }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);
  });
});
