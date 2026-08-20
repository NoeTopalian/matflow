// DEMO_TENANTS production guard (2026-08-18).
//
// `app/api/tenant/[slug]/route.ts` carries a hardcoded DEMO_TENANTS map so the
// login page still renders with no database attached. Its old catch block ran
// on EVERY failure of the try — including the deliberate "not found" throw —
// with no environment check, so in production a database outage, or simply a
// suspended tenant, could be answered with fabricated club branding at HTTP
// 200. UI-RULES §7 bans fabricated placeholder data and says an HTTP error is
// never an empty state.
//
// This suite pins both halves:
//   - production NEVER receives fabricated branding, whatever fails;
//   - a failed lookup is a 503, not a 404, so the login page can say "try
//     again" instead of telling a real member they mistyped their own club.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { checkRateLimit } from "@/lib/rate-limit";
import { GET } from "@/app/api/tenant/[slug]/route";

const mockedBypass = vi.mocked(withRlsBypass);
const mockedRateLimit = vi.mocked(checkRateLimit);

// The one slug DEMO_TENANTS can fabricate. If it is ever renamed, this suite
// must be updated with it — a guard tested against a key the map does not hold
// would pass while proving nothing.
const DEMO_SLUG = "totalbjj";
const FABRICATED_NAME = "Total BJJ";

function call(slug: string) {
  return GET(new Request(`http://localhost/api/tenant/${slug}`), {
    params: Promise.resolve({ slug }),
  });
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  consoleError.mockRestore();
});

describe("GET /api/tenant/[slug] — DEMO_TENANTS production guard", () => {
  it("production + database failure: 503, never the fabricated branding", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockRejectedValue(new Error("connection refused"));

    const res = await call(DEMO_SLUG);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain(FABRICATED_NAME);
    expect(JSON.stringify(body)).not.toContain("#3b82f6");
    expect(consoleError).toHaveBeenCalled();
  });

  it("production + database failure on an unknown slug: 503, not a 404", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockRejectedValue(new Error("connection refused"));

    const res = await call("some-other-club");

    // 404 would tell a real member their own club code is wrong during an
    // outage. The failure has to look like a failure.
    expect(res.status).toBe(503);
  });

  it("production + suspended tenant whose slug matches the demo map: 404, never fabricated branding", async () => {
    // The old code threw "not found" here and fell into the same catch, so a
    // suspended Total BJJ kept serving branding forever.
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockResolvedValue({
      name: FABRICATED_NAME,
      slug: DEMO_SLUG,
      logoUrl: null,
      primaryColor: "#3b82f6",
      secondaryColor: "#2563eb",
      textColor: "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
      subscriptionStatus: "suspended",
      deletedAt: null,
    } as never);

    const res = await call(DEMO_SLUG);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(FABRICATED_NAME);
  });

  it("production + soft-deleted tenant whose slug matches the demo map: 404, never fabricated branding", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockResolvedValue({
      name: FABRICATED_NAME,
      slug: DEMO_SLUG,
      logoUrl: null,
      primaryColor: "#3b82f6",
      secondaryColor: "#2563eb",
      textColor: "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
      subscriptionStatus: "active",
      deletedAt: new Date(),
    } as never);

    const res = await call(DEMO_SLUG);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(FABRICATED_NAME);
  });

  it("production + slug absent from the database: 404, never fabricated branding", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockResolvedValue(null as never);

    const res = await call(DEMO_SLUG);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(JSON.stringify(body)).not.toContain(FABRICATED_NAME);
  });

  it("non-production + database failure: the demo fallback still works for local development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mockedBypass.mockRejectedValue(new Error("no DATABASE_URL"));

    const res = await call(DEMO_SLUG);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect((body as { name: string }).name).toBe(FABRICATED_NAME);
  });

  it("non-production + database failure on a slug the demo map does not hold: still 503", async () => {
    vi.stubEnv("NODE_ENV", "development");
    mockedBypass.mockRejectedValue(new Error("no DATABASE_URL"));

    const res = await call("some-other-club");

    expect(res.status).toBe(503);
  });

  it("does NOT edge-cache the 503 — an outage must not be cached as a club's identity", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockedBypass.mockRejectedValue(new Error("connection refused"));

    const res = await call(DEMO_SLUG);

    expect((res.headers as unknown as Record<string, string>)["Cache-Control"]).toBeUndefined();
  });
});
