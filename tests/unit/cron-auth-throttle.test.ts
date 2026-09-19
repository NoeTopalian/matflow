// The four /api/cron/* routes authenticate on a bearer and nothing else.
// Round 1 made the comparison constant-time and reported the other half of the
// finding: there was no limit of ANY kind on the attempt count, so the only
// brake on guessing CRON_SECRET was its length. Round 2 adds the brake.
//
// The contract has two halves and both matter:
//   • a failed attempt spends budget, and an exhausted bucket answers 429 with
//     a Retry-After — never a 500, never a silent 401 that hides the throttle;
//   • a VALID bearer never touches the bucket at all, so Vercel's scheduler
//     cannot throttle itself however often it runs.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { checkCronAuthAttemptMock, generateMonthlyReportMock } = vi.hoisted(() => ({
  checkCronAuthAttemptMock: vi.fn<() => Promise<{ allowed: boolean; retryAfterSeconds: number }>>(),
  generateMonthlyReportMock: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkCronAuthAttempt: checkCronAuthAttemptMock,
  checkRateLimit: vi.fn(),
  getClientIp: () => "test",
}));
vi.mock("@/lib/ai-causal-report", () => ({ generateMonthlyReport: generateMonthlyReportMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: vi.fn(async () => []),
  withTenantContext: vi.fn(async () => []),
}));

function req(auth?: string) {
  return new Request("http://test/api/cron/monthly-reports", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

const SECRET = "cron-secret-for-this-test-only";

describe("the cron bearer door has a brake on the attempt count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", SECRET);
    checkCronAuthAttemptMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  it("answers 401 for a wrong bearer while the bucket has room, and spends one attempt", async () => {
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(req("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(checkCronAuthAttemptMock).toHaveBeenCalledTimes(1);
  });

  it("answers 429 with a Retry-After once the bucket is spent — never a 500", async () => {
    checkCronAuthAttemptMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(req("Bearer not-the-secret"));
    expect(res.status).toBe(429);
    expect(res.status).not.toBe(500);
    expect((await res.json()) as { error?: string }).toEqual({
      error: "Too many attempts. Try again shortly.",
    });
    expect((res.headers as unknown as Record<string, string>)["Retry-After"]).toBe("42");
  });

  it("throttles a missing header too — an empty attempt is still an attempt", async () => {
    checkCronAuthAttemptMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(req());
    expect(res.status).toBe(429);
  });

  it("never touches the bucket when the bearer is right — the scheduler cannot throttle itself", async () => {
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(429);
    expect(checkCronAuthAttemptMock).not.toHaveBeenCalled();
  });

  it("still refuses before the throttle when CRON_SECRET is not configured at all", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(503);
    expect(checkCronAuthAttemptMock).not.toHaveBeenCalled();
  });
});
