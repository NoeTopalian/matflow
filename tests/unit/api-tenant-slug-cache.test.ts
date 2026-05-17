import { vi, describe, it, expect, beforeEach } from "vitest";

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

const EXPECTED_CACHE = "public, s-maxage=60, stale-while-revalidate=600";

function makeReq() {
  return new Request("http://localhost/api/tenant/totalbjj");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
});

describe("GET /api/tenant/[slug] — cache header contract", () => {
  it("sets Cache-Control on the success path", async () => {
    mockedBypass.mockResolvedValue({
      name: "Total BJJ",
      slug: "totalbjj",
      logoUrl: null,
      primaryColor: "#3b82f6",
      secondaryColor: "#2563eb",
      textColor: "#ffffff",
      bgColor: "#111111",
      fontFamily: "'Inter', sans-serif",
      subscriptionStatus: "active",
      deletedAt: null,
    } as never);

    const res = await GET(makeReq(), { params: Promise.resolve({ slug: "totalbjj" }) });
    expect(res.status).toBe(200);
    expect(res.headers["Cache-Control"]).toBe(EXPECTED_CACHE);
  });

  it("does NOT set Cache-Control on the 404 path (so a future tenant can claim a free slug without stale cache)", async () => {
    mockedBypass.mockResolvedValue(null as never);

    const res = await GET(makeReq(), { params: Promise.resolve({ slug: "nonexistent" }) });
    expect(res.status).toBe(404);
    expect(res.headers["Cache-Control"]).toBeUndefined();
  });

  it("does NOT set Cache-Control when the rate-limit fires", async () => {
    mockedRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });

    const res = await GET(makeReq(), { params: Promise.resolve({ slug: "totalbjj" }) });
    expect(res.status).toBe(429);
    expect(res.headers["Cache-Control"]).toBeUndefined();
    expect(mockedBypass).not.toHaveBeenCalled();
  });

  it("does NOT cache responses for suspended / cancelled / soft-deleted tenants (treated as 404)", async () => {
    mockedBypass.mockResolvedValue({
      name: "Old Gym",
      slug: "oldgym",
      logoUrl: null,
      primaryColor: "#000",
      secondaryColor: "#000",
      textColor: "#fff",
      bgColor: "#000",
      fontFamily: "'Inter', sans-serif",
      subscriptionStatus: "suspended",
      deletedAt: null,
    } as never);

    const res = await GET(makeReq(), { params: Promise.resolve({ slug: "oldgym" }) });
    expect(res.status).toBe(404);
    expect(res.headers["Cache-Control"]).toBeUndefined();
  });
});
