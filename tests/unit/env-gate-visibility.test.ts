import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Sprint 5 US-502: env-dependent endpoints must return informative 503s
// instead of silently no-op'ing or returning generic errors.

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
    tenant: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    user: { findFirst: vi.fn() },
    passwordResetToken: { updateMany: vi.fn(), create: vi.fn() },
    monthlyReport: { create: vi.fn() },
  },
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn().mockResolvedValue({ tenantId: "t1", userId: "u1", role: "owner" }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/google-drive", () => ({
  buildAuthUrl: vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?stub"),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

// Fix 1: forgot-password now imports @/lib/token-hash, which transitively
// loads @/lib/auth-secret. The auth-secret module throws at import time
// when NODE_ENV=production and AUTH_SECRET is unset — which this test
// deliberately exercises. Mocking the helper keeps this test isolated.
vi.mock("@/lib/token-hash", () => ({
  hashToken: (raw: string) => `mocked-hash:${raw}`,
}));

import { prisma } from "@/lib/prisma";

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Restore env between tests so leftovers from one test don't leak.
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
});

// ── forgot-password: RESEND_API_KEY guard ─────────────────────────────────────

describe("POST /api/auth/forgot-password — RESEND_API_KEY env gate", () => {
  it("returns 503 in production when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    // NODE_ENV is readonly under strict TS; set via stubEnv. Reset in afterEach.
    vi.stubEnv("NODE_ENV", "production");

    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "t1", name: "Gym" } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1" } as never);

    const { POST } = await import("@/app/api/auth/forgot-password/route");
    const res = await POST(
      new Request("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@gym.com", tenantSlug: "gym" }),
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/RESEND_API_KEY/);
  });
});

// ── cron/monthly-reports: ANTHROPIC_API_KEY guard ─────────────────────────────

describe("GET /api/cron/monthly-reports — ANTHROPIC_API_KEY env gate", () => {
  it("returns 503 when ANTHROPIC_API_KEY is unset", async () => {
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.ANTHROPIC_API_KEY;

    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(
      new Request("http://localhost/api/cron/monthly-reports", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/ANTHROPIC_API_KEY/);
  });
});

// ── drive/connect: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET guard ──────────────

describe("GET /api/drive/connect — GOOGLE_CLIENT_ID env gate", () => {
  it("returns 503 when GOOGLE_CLIENT_ID is unset", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;

    const { GET } = await import("@/app/api/drive/connect/route");
    const res = await GET();

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/GOOGLE_CLIENT_ID/);
  });
});
