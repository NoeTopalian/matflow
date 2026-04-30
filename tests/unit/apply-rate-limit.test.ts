import { vi, describe, it, expect, beforeEach } from "vitest";

// Sprint 5 US-505: /api/apply rate limit — 5/hour/IP, then 429 with Retry-After.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn().mockReturnValue("203.0.113.42"),
}));

import { checkRateLimit } from "@/lib/rate-limit";
import { POST } from "@/app/api/apply/route";

const checkRateLimitMock = vi.mocked(checkRateLimit);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(body = { gymName: "G", ownerName: "O", email: "o@g.com", phone: "+44 7", sport: "BJJ", memberCount: "1-50" }) {
  return new Request("http://localhost/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/apply — rate limit", () => {
  it("returns 200 when under the limit", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });

  it("returns 429 with Retry-After header when over the limit", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 1500 });
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect((res.headers as unknown as Record<string, string>)["Retry-After"]).toBe("1500");
  });

  it("uses the apply:{ip} bucket key", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    await POST(makeReq());
    expect(checkRateLimitMock).toHaveBeenCalledWith("apply:203.0.113.42", 5, 60 * 60 * 1000);
  });

  it("rate-limits BEFORE validation — drains less effort on spam", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    // Even with empty body, rate limit fires first.
    const res = await POST(new Request("http://localhost/api/apply", { method: "POST", body: "{}" }));
    expect(res.status).toBe(429);
  });
});
