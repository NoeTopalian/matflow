import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
    redirect: (url: URL | string) => ({
      status: 302,
      headers: { location: url instanceof URL ? url.toString() : url },
      cookies: { set: vi.fn() },
    }),
  },
  NextRequest: class {
    url: string;
    headers: Headers;
    constructor(url: string, init?: RequestInit) {
      this.url = url;
      this.headers = new Headers(init?.headers as HeadersInit);
    }
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn() },
    member: { findFirst: vi.fn() },
    magicLinkToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true, logId: "log-1" }),
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  })),
}));

vi.mock("next-auth/jwt", () => ({
  encode: vi.fn().mockResolvedValue("encoded-jwt-token"),
}));

vi.mock("@/lib/auth-secret", () => ({
  AUTH_SECRET_VALUE: "test-secret",
}));

import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "@/app/api/auth/magic-link/request/route";
import { GET } from "@/app/api/auth/magic-link/verify/route";
import { randomBytes } from "crypto";

const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockTokenUpdateMany = vi.mocked(prisma.magicLinkToken.updateMany);
const mockTokenCreate = vi.mocked(prisma.magicLinkToken.create);
const mockTokenFindUnique = vi.mocked(prisma.magicLinkToken.findUnique);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

beforeEach(() => vi.clearAllMocks());

// ── 1. Atomic consume: used/expired token returns redirect ────────────────────

describe("verify — atomic consume rejects used/expired token", () => {
  it("redirects to /login?error=invalid_link when updateMany returns count 0", async () => {
    mockTokenUpdateMany.mockResolvedValue({ count: 0 });

    const req = new Request(
      "http://localhost/api/auth/magic-link/verify?token=deadbeef",
    );
    // Cast to NextRequest-like shape the route handler accepts
    const res = await GET(req as never);

    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>).location).toContain(
      "/login?error=invalid_link",
    );
    // Token row must NOT be read after failed consume
    expect(mockTokenFindUnique).not.toHaveBeenCalled();
  });
});

// ── 2. Atomic consume race: second call with same token fails ─────────────────

describe("verify — concurrent verify: first wins, second rejected", () => {
  it("first call (count=1) succeeds, second call (count=0) redirects to error", async () => {
    // First call: token found and consumed
    mockTokenUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-1",
      email: "user@gym.com",
      purpose: "login",
    } as never);

    mockUserFindFirst.mockResolvedValue({
      id: "user-1",
      tenantId: "tenant-1",
      email: "user@gym.com",
      name: "Test User",
      role: "admin",
      sessionVersion: 0,
    } as never);

    mockTenantFindUnique.mockResolvedValue({ slug: "test-gym" } as never);

    const makeReq = () =>
      new Request("http://localhost/api/auth/magic-link/verify?token=racetoken") as never;

    const res1 = await GET(makeReq());
    const res2 = await GET(makeReq());

    // First wins — redirects to dashboard (not error)
    expect(res1.status).toBe(302);
    expect((res1.headers as Record<string, string>).location).not.toContain(
      "error=invalid_link",
    );

    // Second loses — redirects to error
    expect(res2.status).toBe(302);
    expect((res2.headers as Record<string, string>).location).toContain(
      "/login?error=invalid_link",
    );
  });
});

// ── 3. Cross-tenant replay: token row tenant != resolved user tenant ───────────

describe("verify — cross-tenant replay is rejected", () => {
  it("returns error redirect when no user/member found for token's tenantId", async () => {
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });

    // Token row has tenantId tenant-A
    mockTokenFindUnique.mockResolvedValue({
      tenantId: "tenant-A",
      email: "attacker@gym.com",
      purpose: "login",
    } as never);

    // No user or member found for tenant-A + that email (cross-tenant scenario)
    mockUserFindFirst.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request(
      "http://localhost/api/auth/magic-link/verify?token=crosstoken",
    ) as never;
    const res = await GET(req);

    expect(res.status).toBe(302);
    expect((res.headers as Record<string, string>).location).toContain(
      "/login?error=invalid_link",
    );
  });
});

// ── 4. Token entropy: randomBytes(32).toString("hex") = 64-char hex ───────────

describe("token entropy", () => {
  it("produces a 64-character lowercase hex string", () => {
    for (let i = 0; i < 10; i++) {
      const token = randomBytes(32).toString("hex");
      expect(token).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    }
  });
});

// ── 5. No-enumeration on request: non-existent user returns {ok:true} 200 ─────

describe("request — no enumeration", () => {
  it("returns 200 {ok:true} and never creates a token when user/member not found", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
    mockUserFindFirst.mockResolvedValue(null);
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost/api/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ghost@gym.com", tenantSlug: "test-gym" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });
});

// ── 6. Anti-stockpile: updateMany called BEFORE create ────────────────────────

describe("request — anti-stockpile: prior tokens invalidated before new one created", () => {
  it("calls updateMany (invalidate) before create (new token)", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1", name: "Test Gym" } as never);
    mockUserFindFirst.mockResolvedValue({ id: "u1" } as never);
    mockTokenUpdateMany.mockResolvedValue({ count: 1 });
    mockTokenCreate.mockResolvedValue({ id: "tok-1" } as never);

    const callOrder: string[] = [];
    mockTokenUpdateMany.mockImplementation(async () => {
      callOrder.push("updateMany");
      return { count: 1 };
    });
    mockTokenCreate.mockImplementation(async () => {
      callOrder.push("create");
      return { id: "tok-1" } as never;
    });

    // Suppress email send in this test — RESEND_API_KEY not set, NODE_ENV = test (not production)
    const req = new Request("http://localhost/api/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@gym.com", tenantSlug: "test-gym" }),
    });

    await POST(req);

    const updateIdx = callOrder.indexOf("updateMany");
    const createIdx = callOrder.indexOf("create");
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(updateIdx);
  });
});

// ── 7. Rate-limit: silent 200 when rate-limited (no enumeration) ──────────────

describe("request — rate-limit returns silent 200", () => {
  it("returns 200 {ok:true} when rate-limited (no 429 exposed)", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });

    const req = new Request("http://localhost/api/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@gym.com", tenantSlug: "test-gym" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    // No DB calls after rate-limit check
    expect(mockTenantFindUnique).not.toHaveBeenCalled();
    expect(mockTokenCreate).not.toHaveBeenCalled();
  });
});
